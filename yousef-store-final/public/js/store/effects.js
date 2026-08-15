/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $ } from './core.js';

export function countUp(el, target, dur = 1600) {
  const start = performance.now();
  function tick(now) {
    const p = Math.min((now - start) / dur, 1);
    el.textContent = Math.floor((1 - Math.pow(1 - p, 3)) * target).toLocaleString('en-US');
    if (p < 1) requestAnimationFrame(tick);
    else el.textContent = target.toLocaleString('en-US');
  }
  requestAnimationFrame(tick);
}

/* كل التأثيرات البصرية في مكان واحد. */
export function wireEffects() {
  let preloaderDismissed = false;
  function dismissPreloader() {
    if (preloaderDismissed) return;
    preloaderDismissed = true;
    const pre = $('preloader');
    if (pre) {
      pre.classList.add('done');
      setTimeout(function () { pre.remove(); }, 800);
    }
    document.body.classList.remove('no-scroll');
  }

  // ما نعتمدش على حدث load وحده: لو ملف الموديول اتنفّذ بعد الحدث (كاش أو
  // اتصال بطيء) المستمع مش هيشتغل، فتفضل شاشة التحميل حاجبة الموقع للأبد.
  if (document.readyState === 'complete') {
    setTimeout(dismissPreloader, 250);
  } else {
    window.addEventListener('load', () => setTimeout(dismissPreloader, 250), { once: true });
  }
  // حارس أخير لو صورة/خط خارجي منع load من الاكتمال.
  setTimeout(dismissPreloader, 3000);
  document.body.classList.add('no-scroll');

const scrollBar = $('scrollProgress');
// (إصلاح أداء) الحساب بقى مرة واحدة لكل إطار (rAF) بدل كل حدث سكرول، ومرجع
// الهيدر متخزّن، فمفيش layout thrashing على الموبايل.
const siteHeaderEl = document.querySelector('.site-header');
let scrollTicking = false;
window.addEventListener('scroll', () => {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrollTicking = false;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const pct = max > 0 ? (window.scrollY / max) * 100 : 0;
    if (scrollBar) scrollBar.style.width = pct + '%';
    siteHeaderEl?.classList.toggle('scrolled', window.scrollY > 40);
  });
}, { passive: true });

(function initCanvas() {
  const canvas = $('heroCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h;
  const particles = [];

  function resize() {
    w = canvas.width = canvas.offsetWidth;
    h = canvas.height = canvas.offsetHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < 60; i++) {
    particles.push({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
      r: Math.random() * 2 + 0.5, o: Math.random() * 0.5 + 0.1
    });
  }

  // (إصلاح أداء) كانت المقارنة O(n²) على كل فريم وشغالة حتى والتاب مخفي —
  // ده كان بياكل بطارية الموبايل. دلوقتي: شبكة مكانية (grid) فبنقارن الجيران
  // القريبين بس، إيقاف كامل لما الصفحة تكون مخفية، واحترام تقليل الحركة.
  const LINK_DIST = 120;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let rafId = null;

  function drawFrame() {
    ctx.clearRect(0, 0, w, h);
    const cellSize = LINK_DIST;
    const cells = new Map();
    particles.forEach((p) => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 106, 44, ${p.o})`;
      ctx.fill();
      const key = `${Math.floor(p.x / cellSize)},${Math.floor(p.y / cellSize)}`;
      let bucket = cells.get(key);
      if (!bucket) { bucket = []; cells.set(key, bucket); }
      bucket.push(p);
    });
    cells.forEach((bucket, key) => {
      const [cx, cy] = key.split(',').map(Number);
      const neighbours = [];
      for (let dx = 0; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy < 0) continue;
          const other = cells.get(`${cx + dx},${cy + dy}`);
          if (other && !(dx === 0 && dy === 0)) neighbours.push(...other);
        }
      }
      bucket.forEach((p, i) => {
        const candidates = bucket.slice(i + 1).concat(neighbours);
        candidates.forEach((p2) => {
          const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
          if (dist < LINK_DIST) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(255, 106, 44, ${0.08 * (1 - dist / LINK_DIST)})`;
            ctx.stroke();
          }
        });
      });
    });
  }

  function loop() {
    drawFrame();
    rafId = requestAnimationFrame(loop);
  }
  function start() {
    if (rafId === null && !document.hidden && !reduceMotion) rafId = requestAnimationFrame(loop);
  }
  function stop() {
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
  if (reduceMotion) drawFrame(); else start();
})();

const revealObs = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); revealObs.unobserve(e.target); } });
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => revealObs.observe(el));

const statObs = new IntersectionObserver((entries) => {
  entries.forEach((e) => { if (e.isIntersecting) { countUp(e.target, Number(e.target.dataset.count)); statObs.unobserve(e.target); } });
}, { threshold: 0.5 });
document.querySelectorAll('[data-count]').forEach((el) => statObs.observe(el));

const heroVisual = document.querySelector('.hero-visual-card');
if (heroVisual && window.matchMedia('(pointer:fine)').matches) {
  heroVisual.addEventListener('pointermove', (e) => {
    const r = heroVisual.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    heroVisual.style.transform = `perspective(1200px) rotateY(${x * 10}deg) rotateX(${-y * 10}deg) translateY(-6px)`;
  });
  heroVisual.addEventListener('pointerleave', () => { heroVisual.style.transform = ''; });
}

}
