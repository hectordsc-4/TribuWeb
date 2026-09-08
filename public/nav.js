(function () {
  const root = document.getElementById('review-carousel');
  if (!root) return;
  const cards = [...root.querySelectorAll('.review-card')];
  const dotsWrap = root.querySelector('.review-dots');
  if (cards.length < 2 || !dotsWrap) return;
  let index = 0;
  let timer;
  cards.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.setAttribute('aria-label', 'Opinión ' + (i + 1));
    if (i === 0) dot.classList.add('is-active');
    dot.addEventListener('click', () => go(i, true));
    dotsWrap.appendChild(dot);
  });
  const dots = [...dotsWrap.querySelectorAll('button')];
  function go(next, pause) {
    cards[index].classList.remove('is-active');
    dots[index].classList.remove('is-active');
    index = (next + cards.length) % cards.length;
    cards[index].classList.add('is-active');
    dots[index].classList.add('is-active');
    if (pause) restart();
  }
  function restart() {
    clearInterval(timer);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    timer = setInterval(() => go(index + 1), 6000);
  }
  restart();
})();

(function () {
  const slides = document.querySelectorAll('.hero-slides img');
  if (slides.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let index = 0;
    setInterval(() => {
      slides[index].classList.remove('is-active');
      index = (index + 1) % slides.length;
      slides[index].classList.add('is-active');
    }, 5000);
  }
})();

(function () {
  const menu = document.getElementById('mobile-menu');
  const toggle = document.getElementById('menu-toggle');
  const links = document.querySelectorAll('.nav-link');
  const page = document.body.getAttribute('data-page');
  const sections = ['inicio', 'servicios', 'nosotras']
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  function setOpen(open) {
    if (!menu || !toggle) return;
    menu.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('.material-symbols-outlined').textContent = open ? 'close' : 'menu';
  }

  if (toggle && menu) {
    toggle.addEventListener('click', () => setOpen(menu.classList.contains('hidden')));
  }

  links.forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });

  function markCurrent(hash) {
    const target = hash || '#inicio';
    links.forEach((link) => {
      const href = link.getAttribute('href') || '';
      let isCurrent = false;
      if (page === 'carta') {
        isCurrent = href.includes('carta.html');
      } else if (page === 'reservar') {
        isCurrent = href.includes('reservar.html');
      } else if (page === 'contacto') {
        isCurrent = false;
      } else {
        isCurrent = href === target || href.endsWith(target);
      }
      link.classList.toggle('nav-current', isCurrent);
      if (!link.classList.contains('nav-contact')) {
        link.classList.toggle('text-on-surface-variant', !isCurrent);
      }
    });
  }

  if (page === 'contacto' || page === 'carta' || page === 'reservar' || !sections.length) {
    markCurrent('');
    return;
  }

  function onScroll() {
    const offset = 140;
    let current = 'inicio';
    sections.forEach((section) => {
      if (section.getBoundingClientRect().top <= offset) current = section.id;
    });
    markCurrent('#' + current);
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  markCurrent(window.location.hash || '#inicio');
})();
