let refundTarget = null;
let occupancyData = null;
let selectedOccupancyDate = null;
let closedDaysMap = new Map();
let calendarAnchor = null;

const eurosToCents = (value) => Math.round(Number(value) * 100);
const centsToEuros = (cents) => (Number(cents) / 100).toFixed(2);

function weekdayFromDate(dateStr) {
  try {
    return new Intl.DateTimeFormat('es-ES', { weekday: 'long' }).format(
      new Date(`${dateStr}T12:00:00`)
    );
  } catch {
    return '';
  }
}

function shortDayLabel(dateStr) {
  try {
    return new Intl.DateTimeFormat('es-ES', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
    }).format(new Date(`${dateStr}T12:00:00`));
  } catch {
    return dateStr;
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const configStatus = document.getElementById('config-status');
const refundDialog = document.getElementById('refund-dialog');
const refundForm = document.getElementById('refund-form');
const refundSummary = document.getElementById('refund-summary');
const refundAmountInput = document.getElementById('refund-amount');
const refundReasonInput = document.getElementById('refund-reason');
const refundMessage = document.getElementById('refund-message');
const refundCancel = document.getElementById('refund-cancel');
const reservasFilter = document.getElementById('reservas-filter');
const reservasFrom = document.getElementById('reservas-from');
const reservasTo = document.getElementById('reservas-to');
const reservasQ = document.getElementById('reservas-q');
const reservasList = document.getElementById('reservas-list');
const ocupacionFilter = document.getElementById('ocupacion-filter');
const ocupacionFrom = document.getElementById('ocupacion-from');
const ocupacionTo = document.getElementById('ocupacion-to');
const occByDay = document.getElementById('occ-by-day');
const occByHour = document.getElementById('occ-by-hour');
const occHourSubtitle = document.getElementById('occ-hour-subtitle');
const occTotalBadge = document.getElementById('occ-total-badge');
const occDetailBadge = document.getElementById('occ-detail-badge');
const occReservations = document.getElementById('occ-reservations');
const calendarMonths = document.getElementById('calendar-months');
const calendarMessage = document.getElementById('calendar-message');
const calPrev = document.getElementById('cal-prev');
const calNext = document.getElementById('cal-next');
const calToday = document.getElementById('cal-today');

function setMessage(el, text, type = '') {
  el.textContent = text || '';
  el.className = `message ${type}`.trim();
}

function setDefaultRanges() {
  const today = todayISO();
  reservasFrom.value = addDaysISO(today, -7);
  reservasTo.value = addDaysISO(today, 14);
  ocupacionFrom.value = today;
  ocupacionTo.value = addDaysISO(today, 7);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error HTTP ${res.status}`);
  return data;
}

function switchView(viewName) {
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.view === viewName;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.view').forEach((view) => {
    const active = view.id === `view-${viewName}`;
    view.classList.toggle('active', active);
    view.hidden = !active;
  });

  if (viewName === 'reservas') loadReservas();
  if (viewName === 'ocupacion') loadOccupancy();
  if (viewName === 'calendario') loadCalendar();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

async function init() {
  setDefaultRanges();
  calendarAnchor = startOfMonth(new Date());

  try {
    const health = await api('/api/health');
    if (!health.ok) throw new Error('Servicio no disponible');
    configStatus.textContent = 'Panel listo';
    configStatus.classList.add('ok');
    await loadReservas();
  } catch (err) {
    configStatus.textContent = 'No se pudo conectar al servidor';
    configStatus.classList.add('bad');
  }
}

function bookingSummary(tx) {
  const b = tx.metadata?.booking;
  if (!b) return tx.description ? escapeHtml(tx.description) : '';
  const weekday = b.date ? weekdayFromDate(b.date) : b.weekday || '';
  return `${b.plazas} plaza${b.plazas === 1 ? '' : 's'} · ${escapeHtml(weekday)} ${escapeHtml(b.date)} · ${escapeHtml(b.time_from)}–${escapeHtml(b.time_to)}`;
}

function contactFromTx(tx) {
  const b = tx.metadata?.booking || {};
  return {
    name: b.contact_name || tx.customer_name || b.customer_name || '',
    email: b.email || tx.customer_email || '',
    canceled: b.canceled === true || tx.status === 'canceled_booking',
  };
}

function renderReservationCard(tx) {
  const contact = contactFromTx(tx);
  const bookingLine = bookingSummary(tx);
  const canRefund =
    tx.type === 'charge' &&
    ['succeeded', 'canceled_booking'].includes(tx.status) &&
    tx.refundable_amount > 0;
  const canCancel = tx.type === 'charge' && !contact.canceled && tx.metadata?.booking;

  return `
    <article class="tx-card">
      <div class="tx-top">
        <div>
          <span class="badge charge">Reserva</span>
          ${contact.canceled ? '<span class="badge canceled">Cancelada</span>' : ''}
          <span class="badge status-${escapeHtml(tx.status)}">${escapeHtml(tx.status)}</span>
        </div>
        <div class="tx-amount">${centsToEuros(tx.amount)} ${(tx.currency || 'eur').toUpperCase()}</div>
      </div>
      <div class="tx-meta">
        ${contact.name ? `<strong>${escapeHtml(contact.name)}</strong><br />` : ''}
        ${contact.email ? `${escapeHtml(contact.email)}<br />` : ''}
        #${tx.id}${bookingLine ? ` · ${bookingLine}` : ''}
        ${
          canRefund || tx.refundable_amount > 0
            ? `<br />Reembolsable: ${centsToEuros(tx.refundable_amount || 0)} EUR`
            : ''
        }
      </div>
      ${
        canRefund || canCancel
          ? `<div class="actions">
              ${
                canRefund
                  ? `<button type="button" class="btn danger small" data-refund="${tx.id}" data-max="${tx.refundable_amount}">Devolver pago</button>`
                  : ''
              }
              ${
                canCancel
                  ? `<button type="button" class="btn warn small" data-cancel="${tx.id}">Cancelar reserva</button>`
                  : ''
              }
            </div>`
          : ''
      }
    </article>
  `;
}

function bindReservationActions(root) {
  root.querySelectorAll('[data-refund]').forEach((btn) => {
    btn.addEventListener('click', () =>
      openRefundDialog(Number(btn.dataset.refund), Number(btn.dataset.max))
    );
  });
  root.querySelectorAll('[data-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => cancelBooking(Number(btn.dataset.cancel)));
  });
}

async function loadReservas() {
  try {
    const from = reservasFrom.value;
    const to = reservasTo.value;
    if (!from || !to) {
      reservasList.innerHTML = `<p class="empty">Indica el rango de fechas.</p>`;
      return;
    }
    if (from > to) throw new Error('La fecha "Desde" no puede ser posterior a "Hasta".');

    const params = new URLSearchParams({
      bookings_only: 'true',
      date_from: from,
      date_to: to,
      limit: '200',
    });
    const q = reservasQ.value.trim();
    if (q) params.set('q', q);

    const { transactions } = await api(`/api/transactions?${params}`);
    if (!transactions.length) {
      reservasList.innerHTML = `<p class="empty">No hay reservas en ese rango.</p>`;
      return;
    }

    reservasList.innerHTML = transactions.map((tx) => renderReservationCard(tx)).join('');
    bindReservationActions(reservasList);
  } catch (err) {
    reservasList.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

reservasFilter.addEventListener('submit', (event) => {
  event.preventDefault();
  loadReservas();
});

async function loadOccupancy() {
  try {
    const from = ocupacionFrom.value;
    const to = ocupacionTo.value;
    if (!from || !to) return;
    if (from > to) throw new Error('La fecha "Desde" no puede ser posterior a "Hasta".');

    const params = new URLSearchParams({ date_from: from, date_to: to });
    occupancyData = await api(`/api/transactions/occupancy?${params}`);
    occTotalBadge.textContent = String(occupancyData.totalPeople || 0);
    occDetailBadge.textContent = String(occupancyData.reservations?.length || 0);

    const byDay = occupancyData.byDay || [];
    const maxPeople = Math.max(1, ...byDay.map((d) => d.people));

    if (!byDay.length) {
      occByDay.innerHTML = `<p class="empty">Sin ocupación en este rango.</p>`;
      selectedOccupancyDate = null;
      renderHourMap(null);
    } else {
      if (!selectedOccupancyDate || !byDay.some((d) => d.date === selectedOccupancyDate)) {
        selectedOccupancyDate = byDay[0].date;
      }
      occByDay.innerHTML = byDay
        .map((day) => {
          const pct = Math.max(8, Math.round((day.people / maxPeople) * 100));
          const active = day.date === selectedOccupancyDate ? 'active' : '';
          return `
            <button type="button" class="day-row ${active}" data-day="${day.date}">
              <span class="day-label">${escapeHtml(shortDayLabel(day.date))}</span>
              <span class="day-bar"><span style="width:${pct}%"></span></span>
              <span class="day-count">${day.people}</span>
            </button>
          `;
        })
        .join('');

      occByDay.querySelectorAll('[data-day]').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedOccupancyDate = btn.dataset.day;
          occByDay.querySelectorAll('.day-row').forEach((row) => {
            row.classList.toggle('active', row.dataset.day === selectedOccupancyDate);
          });
          renderHourMap(selectedOccupancyDate);
        });
      });
      renderHourMap(selectedOccupancyDate);
    }

    const list = occupancyData.reservations || [];
    if (!list.length) {
      occReservations.innerHTML = `<p class="empty">Sin reservas en este rango.</p>`;
    } else {
      occReservations.innerHTML = list.map((tx) => renderReservationCard(tx)).join('');
      bindReservationActions(occReservations);
    }
  } catch (err) {
    occByDay.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    occReservations.innerHTML = '';
  }
}

function renderHourMap(date) {
  if (!date || !occupancyData?.byHour?.[date]) {
    occHourSubtitle.textContent = 'Selecciona un día a la izquierda.';
    occByHour.innerHTML = Array.from({ length: 24 }, (_, hour) => {
      const label = String(hour).padStart(2, '0');
      return `<div class="hour-cell"><div class="h">${label}h</div><div class="n">0</div></div>`;
    }).join('');
    return;
  }

  const hours = occupancyData.byHour[date];
  const total = hours.reduce((sum, h) => sum + h.people, 0);
  const peak = Math.max(0, ...hours.map((h) => h.people));
  occHourSubtitle.textContent = `${shortDayLabel(date)} · ${total} persona(s)`;

  occByHour.innerHTML = hours
    .map((item) => {
      const label = String(item.hour).padStart(2, '0');
      let cls = 'hour-cell';
      if (item.people > 0) cls += ' active';
      if (item.people > 0 && item.people === peak) cls += ' peak';
      return `<div class="${cls}"><div class="h">${label}h</div><div class="n">${item.people}</div></div>`;
    })
    .join('');
}

ocupacionFilter.addEventListener('submit', (event) => {
  event.preventDefault();
  selectedOccupancyDate = null;
  loadOccupancy();
});

function openRefundDialog(transactionId, maxCents) {
  refundTarget = { transactionId, maxCents };
  refundSummary.textContent = `Reserva #${transactionId}. Máximo: ${centsToEuros(maxCents)} EUR.`;
  refundAmountInput.value = centsToEuros(maxCents);
  refundAmountInput.max = centsToEuros(maxCents);
  refundReasonInput.value = '';
  setMessage(refundMessage, '');
  refundDialog.showModal();
}

refundCancel.addEventListener('click', () => refundDialog.close());

refundForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!refundTarget) return;

  try {
    const amount = eurosToCents(refundAmountInput.value);
    if (amount < 1 || amount > refundTarget.maxCents) {
      throw new Error(`El importe debe estar entre 0,01 y ${centsToEuros(refundTarget.maxCents)} EUR.`);
    }

    await api('/api/payments/refund', {
      method: 'POST',
      body: JSON.stringify({
        transactionId: refundTarget.transactionId,
        amount,
        reason: refundReasonInput.value.trim() || undefined,
      }),
    });

    refundDialog.close();
    await refreshActiveLists();
  } catch (err) {
    setMessage(refundMessage, err.message, 'err');
  }
});

async function cancelBooking(transactionId) {
  const ok = window.confirm(
    `¿Cancelar la reserva #${transactionId}? Podrás devolver el pago después si hace falta.`
  );
  if (!ok) return;

  try {
    await api(`/api/transactions/${transactionId}/cancel`, { method: 'POST', body: '{}' });
    await refreshActiveLists();
  } catch (err) {
    alert(err.message);
  }
}

async function refreshActiveLists() {
  const active = document.querySelector('.tab.active')?.dataset.view;
  if (active === 'reservas') await loadReservas();
  if (active === 'ocupacion') await loadOccupancy();
  if (active === 'calendario') await loadCalendar();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function shiftMonth(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

async function refreshClosedDaysCache(rangeFrom, rangeTo) {
  const from = rangeFrom || addDaysISO(todayISO(), -60);
  const to = rangeTo || addDaysISO(todayISO(), 120);
  const params = new URLSearchParams({ date_from: from, date_to: to });
  const { closedDays } = await api(`/api/calendar/closed-days?${params}`);
  closedDaysMap = new Map((closedDays || []).map((d) => [d.closed_date, d.reason || '']));
}

async function loadCalendar() {
  if (!calendarAnchor) calendarAnchor = startOfMonth(new Date());
  setMessage(calendarMessage, '');

  const months = [0, 1, 2].map((i) => shiftMonth(calendarAnchor, i));
  const from = `${monthKey(months[0])}-01`;
  const last = months[2];
  const to = `${monthKey(last)}-${String(daysInMonth(last.getFullYear(), last.getMonth())).padStart(2, '0')}`;

  try {
    await refreshClosedDaysCache(from, to);
    calendarMonths.innerHTML = months.map((monthDate) => renderMonth(monthDate)).join('');
    calendarMonths.querySelectorAll('[data-cal-date]').forEach((btn) => {
      btn.addEventListener('click', () => toggleClosedDate(btn.dataset.calDate));
    });
  } catch (err) {
    calendarMonths.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
  }
}

function renderMonth(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const title = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(monthDate);
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  const total = daysInMonth(year, month);
  const today = todayISO();
  const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((d) => `<span>${d}</span>`).join('');

  const cells = [];
  for (let i = 0; i < firstDow; i += 1) {
    cells.push('<button type="button" class="cal-day muted" disabled></button>');
  }
  for (let day = 1; day <= total; day += 1) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const classes = ['cal-day'];
    if (iso === today) classes.push('today');
    if (closedDaysMap.has(iso)) classes.push('closed');
    const titleAttr = closedDaysMap.has(iso)
      ? ` title="Cerrado${closedDaysMap.get(iso) ? `: ${escapeHtml(closedDaysMap.get(iso))}` : ''} (clic para abrir)"`
      : ' title="Clic para marcar cierre"';
    cells.push(
      `<button type="button" class="${classes.join(' ')}" data-cal-date="${iso}"${titleAttr}>${day}</button>`
    );
  }

  return `
    <article class="month-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="month-weekdays">${weekdays}</div>
      <div class="month-grid">${cells.join('')}</div>
    </article>
  `;
}

async function toggleClosedDate(date) {
  try {
    const currentlyClosed = closedDaysMap.has(date);
    const reason = currentlyClosed
      ? undefined
      : window.prompt('Motivo del cierre (opcional):', '') ?? undefined;

    if (!currentlyClosed && reason === undefined) return;

    const result = await api('/api/calendar/closed-days/toggle', {
      method: 'POST',
      body: JSON.stringify({
        closedDate: date,
        reason: reason ? String(reason).trim() : null,
      }),
    });

    if (result.closed) {
      closedDaysMap.set(date, result.day?.reason || '');
      setMessage(calendarMessage, `${date} marcado como cerrado.`, 'ok');
    } else {
      closedDaysMap.delete(date);
      setMessage(calendarMessage, `${date} vuelve a estar abierto.`, 'ok');
    }

    await loadCalendar();
  } catch (err) {
    setMessage(calendarMessage, err.message, 'err');
  }
}

calPrev?.addEventListener('click', () => {
  calendarAnchor = shiftMonth(calendarAnchor, -1);
  loadCalendar();
});
calNext?.addEventListener('click', () => {
  calendarAnchor = shiftMonth(calendarAnchor, 1);
  loadCalendar();
});
calToday?.addEventListener('click', () => {
  calendarAnchor = startOfMonth(new Date());
  loadCalendar();
});

init();
