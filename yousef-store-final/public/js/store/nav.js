/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $ } from './core.js';
import { openCart } from './cart.js';

export function setNavHidden(hidden) {
  const nav = document.querySelector('.nav-links');
  if (!nav) return;
  const mobile = window.innerWidth <= 720;
  const shouldHide = mobile && hidden;
  if (shouldHide) { nav.setAttribute('inert', ''); nav.setAttribute('aria-hidden', 'true'); }
  else { nav.removeAttribute('inert'); nav.removeAttribute('aria-hidden'); }
}

export function wireNav() {
$('burgerBtn')?.addEventListener('click', () => {
  const nav = document.querySelector('.nav-links');
  const open = nav.style.display === 'flex';
  nav.style.cssText = open ? '' : 'display:flex;position:fixed;top:var(--header-h);inset-inline:0;background:var(--surface-solid-strong);flex-direction:column;padding:24px;gap:20px;border-bottom:1px solid var(--line);z-index:199;backdrop-filter:blur(12px);';
  // (إتاحة) قارئ الشاشة لازم يعرف القائمة مفتوحة ولا مقفولة.
  $('burgerBtn').setAttribute('aria-expanded', String(!open));
  setNavHidden(open);
});
setNavHidden(true);
window.addEventListener('resize', () => {
  if (window.innerWidth > 720) {
    document.querySelector('.nav-links').style.display = '';
    $('burgerBtn')?.setAttribute('aria-expanded', 'false');
  }
  setNavHidden(document.querySelector('.nav-links')?.style.display !== 'flex');
});
(() => {
  const links = Array.from(document.querySelectorAll('.nav-links a[href^="#"]'));
  if (!links.length || !('IntersectionObserver' in window)) return;
  const setCurrent = (id) => links.forEach((link) => {
    if (link.getAttribute('href') === `#${id}`) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
  const sections = links
    .map((link) => document.querySelector(link.getAttribute('href')))
    .filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    const visible = entries.filter((e) => e.isIntersecting)
      .sort((x, y) => y.intersectionRatio - x.intersectionRatio)[0];
    if (visible) setCurrent(visible.target.id);
  }, { rootMargin: '-45% 0px -45% 0px', threshold: [0, 0.25, 0.5, 1] });
  sections.forEach((section) => observer.observe(section));
})();

document.querySelectorAll('.nav-links a').forEach((a) => a.addEventListener('click', () => {
  if (window.innerWidth <= 720) {
    document.querySelector('.nav-links').style.display = '';
    $('burgerBtn')?.setAttribute('aria-expanded', 'false');
    setNavHidden(true);
  }
}));
$('mobileCartBtn')?.addEventListener('click', openCart);
}
