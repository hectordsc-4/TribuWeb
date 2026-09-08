(function () {
  const wrap = document.querySelector('.carta-wrap');
  const rows = [...document.querySelectorAll('.carta-row')];
  if (!wrap || !rows.length) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Contenedor posicionado sobre la carta
  wrap.style.position = 'relative';

  const pac = document.createElement('div');
  pac.id = 'tribu-pacman';
  pac.className = 'carta-pac';
  pac.setAttribute('aria-hidden', 'true');
  pac.innerHTML = `
    <div class="carta-pac-face" title="Comecocos">
      <span class="carta-pac-eye"></span>
    </div>
  `;
  wrap.appendChild(pac);

  let rowIndex = 0;
  let running = false;

  function setPac(x, y) {
    pac.style.left = `${Math.max(0, x - 30)}px`;
    pac.style.top = `${Math.max(0, y - 30)}px`;
    pac.style.opacity = '1';
    pac.style.visibility = 'visible';
  }

  function rowCoords(row) {
    const wrapRect = wrap.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return {
      left: rect.left - wrapRect.left,
      right: rect.right - wrapRect.left,
      y: rect.top - wrapRect.top + rect.height / 2,
      width: rect.width,
    };
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function eatRow(row) {
    const c = rowCoords(row);
    row.classList.add('is-pac-eating');
    row.style.setProperty('--eat', '0%');
    pac.classList.add('is-chomping');
    setPac(c.left + 10, c.y);

    const duration = reduceMotion ? 400 : Math.min(2200, Math.max(1100, c.width * 5));
    const start = performance.now();

    await new Promise((resolve) => {
      function tick(now) {
        const t = Math.min(1, (now - start) / duration);
        const x = c.left + (c.right - c.left) * t;
        setPac(x, c.y);
        row.style.setProperty('--eat', `${t * 100}%`);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });

    row.classList.remove('is-pac-eating');
    row.classList.add('is-pac-eaten');
    pac.classList.remove('is-chomping');
    setTimeout(() => {
      row.classList.remove('is-pac-eaten');
      row.style.removeProperty('--eat');
    }, 4000);
  }

  async function loop() {
    if (running) return;
    running = true;
    try {
      while (true) {
        const visible = rows.filter((row) => {
          const r = row.getBoundingClientRect();
          return r.bottom > 90 && r.top < window.innerHeight - 40;
        });
        const pool = visible.length ? visible : rows;
        const row = pool[rowIndex % pool.length];
        rowIndex += 1;

        const c = rowCoords(row);
        setPac(c.left + 10, c.y);
        await wait(reduceMotion ? 150 : 300);
        await eatRow(row);
        await wait(reduceMotion ? 200 : 500);
      }
    } catch (err) {
      console.error('pacman error', err);
    } finally {
      running = false;
    }
  }

  // Visible desde el primer momento
  requestAnimationFrame(() => {
    const c = rowCoords(rows[0]);
    setPac(c.left + 10, c.y);
    pac.classList.add('is-ready');
    setTimeout(loop, 400);
  });
})();
