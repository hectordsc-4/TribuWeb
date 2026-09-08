let stripe = null;
let elements = null;
let paymentElement = null;
let currentClientSecret = null;
let currentPaymentIntentId = null;
let closedDaysMap = new Map();

const PRICE_DEFAULT = 8;
const eurosToCents = (value) => Math.round(Number(value) * 100);
const formatEuros = (value) =>
  Number(value).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function weekdayFromDate(dateStr) {
  try {
    return new Intl.DateTimeFormat('es-ES', { weekday: 'long' }).format(
      new Date(`${dateStr}T12:00:00`)
    );
  } catch {
    return '';
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
const chargeForm = document.getElementById('charge-form');
const payBtn = document.getElementById('pay-btn');
const cancelPayBtn = document.getElementById('cancel-pay-btn');
const paymentElementMount = document.getElementById('payment-element');
const chargeMessage = document.getElementById('charge-message');
const bookingDateMessage = document.getElementById('booking-date-message');
const contactNameInput = document.getElementById('contact-name');
const emailInput = document.getElementById('email');
const plazasInput = document.getElementById('plazas');
const priceInput = document.getElementById('price-per-plaza');
const dateInput = document.getElementById('booking-date');
const timeFromInput = document.getElementById('time-from');
const timeToInput = document.getElementById('time-to');
const totalAmountEl = document.getElementById('total-amount');

function setMessage(el, text, type = '') {
  el.textContent = text || '';
  el.className = `book-msg ${type}`.trim();
}

function setDefaultDate() {
  const d = new Date();
  const day = d.getDay();
  const add = day === 6 ? 0 : (6 - day + 7) % 7 || 7;
  d.setDate(d.getDate() + add);
  dateInput.value = d.toISOString().slice(0, 10);
}

function getBookingDraft() {
  const contactName = contactNameInput.value.trim();
  const email = emailInput.value.trim();
  const plazas = Number(plazasInput.value);
  const pricePerPlaza = Number(priceInput.value);
  const date = dateInput.value;
  const timeFrom = timeFromInput.value;
  const timeTo = timeToInput.value;

  if (!contactName) throw new Error('Indica el nombre de contacto.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Indica un email válido.');
  }
  if (!Number.isInteger(plazas) || plazas < 1) throw new Error('Indica al menos 1 plaza.');
  if (!(pricePerPlaza >= 0.5)) throw new Error('El precio por plaza debe ser al menos 0,50 EUR.');
  if (!date) throw new Error('Elige el día de la reserva.');
  if (closedDaysMap.has(date)) {
    const reason = closedDaysMap.get(date);
    throw new Error(
      `Tribu está cerrado ese día${reason ? ` (${reason})` : ''}. Elige otra fecha.`
    );
  }
  if (!timeFrom || !timeTo) throw new Error('Indica la franja horaria.');
  if (timeFrom >= timeTo) {
    throw new Error('La hora de fin debe ser posterior a la de inicio (ej. 10:00–12:00).');
  }

  const totalEuros = plazas * pricePerPlaza;
  const amount = eurosToCents(totalEuros);
  if (amount < 50) throw new Error('El total mínimo es 0,50 EUR.');

  const weekday = weekdayFromDate(date);
  const description = `Tribu · ${contactName} · ${plazas} plaza${plazas === 1 ? '' : 's'} · ${weekday} ${date} · ${timeFrom}–${timeTo}`;

  return {
    contactName,
    email,
    plazas,
    pricePerPlaza,
    date,
    weekday,
    timeFrom,
    timeTo,
    totalEuros,
    amount,
    description,
    booking: {
      product: 'chiquipark',
      plazas,
      price_per_plaza_cents: eurosToCents(pricePerPlaza),
      date,
      weekday,
      time_from: timeFrom,
      time_to: timeTo,
      contact_name: contactName,
      customer_name: contactName,
      email,
    },
  };
}

function updateTotal() {
  try {
    const draft = getBookingDraft();
    totalAmountEl.textContent = `${formatEuros(draft.totalEuros)} EUR`;
  } catch {
    const plazas = Number(plazasInput.value) || 0;
    const price = Number(priceInput.value) || 0;
    totalAmountEl.textContent = `${formatEuros(plazas * price)} EUR`;
  }
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

async function refreshClosedDaysCache() {
  const params = new URLSearchParams({
    date_from: addDaysISO(todayISO(), -30),
    date_to: addDaysISO(todayISO(), 120),
  });
  const { closedDays } = await api(`/api/calendar/closed-days?${params}`);
  closedDaysMap = new Map((closedDays || []).map((d) => [d.closed_date, d.reason || '']));
}

async function checkBookingDateClosed() {
  const date = dateInput.value;
  if (!date) {
    setMessage(bookingDateMessage, '');
    dateInput.classList.remove('input-invalid');
    return;
  }

  try {
    if (!closedDaysMap.has(date)) {
      const { closed, day } = await api(`/api/calendar/closed-days/${date}`);
      if (closed) closedDaysMap.set(date, day?.reason || '');
      else closedDaysMap.delete(date);
    }

    if (closedDaysMap.has(date)) {
      const reason = closedDaysMap.get(date);
      setMessage(
        bookingDateMessage,
        `Tribu está cerrado ese día${reason ? ` (${reason})` : ''}. Elige otra fecha.`,
        'err'
      );
      dateInput.classList.add('input-invalid');
      payBtn.disabled = true;
    } else {
      setMessage(bookingDateMessage, '');
      dateInput.classList.remove('input-invalid');
      if (stripe) payBtn.disabled = false;
    }
  } catch (err) {
    setMessage(bookingDateMessage, err.message, 'err');
  }
}

function resetPaymentUI() {
  if (paymentElement) {
    paymentElement.unmount();
    paymentElement = null;
  }
  elements = null;
  currentClientSecret = null;
  currentPaymentIntentId = null;
  paymentElementMount.classList.add('hidden');
  cancelPayBtn.classList.add('hidden');
  payBtn.textContent = 'Preparar cobro';
  payBtn.disabled = false;
}

function resetBookingForm() {
  contactNameInput.value = '';
  emailInput.value = '';
  plazasInput.value = '2';
  priceInput.value = PRICE_DEFAULT.toFixed(2);
  timeFromInput.value = '10:00';
  timeToInput.value = '12:00';
  setDefaultDate();
  updateTotal();
}

async function init() {
  setDefaultDate();
  updateTotal();
  ['input', 'change'].forEach((evt) => {
    [plazasInput, priceInput, dateInput, timeFromInput, timeToInput, contactNameInput, emailInput].forEach(
      (el) => el.addEventListener(evt, updateTotal)
    );
  });
  dateInput.addEventListener('change', checkBookingDateClosed);
  dateInput.addEventListener('input', checkBookingDateClosed);

  try {
    const { publishableKey, configured } = await api('/api/payments/config');
    if (!configured || !publishableKey) {
      configStatus.textContent = 'Pagos no configurados todavía.';
      configStatus.classList.add('bad');
      payBtn.disabled = true;
      return;
    }
    stripe = Stripe(publishableKey);
    configStatus.textContent = 'Pago seguro con Stripe';
    await refreshClosedDaysCache();
    await checkBookingDateClosed();
  } catch (err) {
    configStatus.textContent = 'No se pudo conectar al servidor de pagos.';
    configStatus.classList.add('bad');
    setMessage(chargeMessage, err.message, 'err');
  }
}

chargeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!stripe) return;
  setMessage(chargeMessage, '');

  try {
    if (!currentClientSecret) {
      payBtn.disabled = true;
      payBtn.textContent = 'Creando…';
      const draft = getBookingDraft();

      const data = await api('/api/payments/create-payment-intent', {
        method: 'POST',
        body: JSON.stringify({
          amount: draft.amount,
          description: draft.description,
          customerName: draft.contactName,
          customerEmail: draft.email,
          booking: draft.booking,
        }),
      });

      currentClientSecret = data.clientSecret;
      currentPaymentIntentId = data.paymentIntentId;

      elements = stripe.elements({
        clientSecret: currentClientSecret,
        appearance: {
          theme: 'stripe',
          variables: {
            colorPrimary: '#1cafb4',
            borderRadius: '12px',
            fontFamily: 'Plus Jakarta Sans, system-ui, sans-serif',
          },
        },
      });

      paymentElement = elements.create('payment');
      paymentElementMount.classList.remove('hidden');
      paymentElement.mount('#payment-element');
      cancelPayBtn.classList.remove('hidden');
      payBtn.textContent = 'Cobrar ahora';
      payBtn.disabled = false;
      setMessage(
        chargeMessage,
        `${draft.description}. Total ${formatEuros(draft.totalEuros)} EUR.`,
        'ok'
      );
      return;
    }

    payBtn.disabled = true;
    payBtn.textContent = 'Procesando…';

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
      confirmParams: {
        return_url: window.location.href,
        receipt_email: emailInput.value.trim() || undefined,
      },
    });

    if (error) throw new Error(error.message);

    if (paymentIntent) {
      await api('/api/payments/confirm-payment', {
        method: 'POST',
        body: JSON.stringify({ paymentIntentId: paymentIntent.id || currentPaymentIntentId }),
      });
    }

    setMessage(chargeMessage, `Reserva pagada (${paymentIntent?.status || 'ok'}). ¡Te esperamos!`, 'ok');
    resetPaymentUI();
    resetBookingForm();
    await checkBookingDateClosed();
  } catch (err) {
    setMessage(chargeMessage, err.message, 'err');
    payBtn.disabled = false;
    payBtn.textContent = currentClientSecret ? 'Cobrar ahora' : 'Preparar cobro';
  }
});

cancelPayBtn.addEventListener('click', () => {
  resetPaymentUI();
  setMessage(chargeMessage, 'Cobro cancelado en pantalla.');
});

init();
