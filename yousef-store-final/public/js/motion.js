/* ---------------------------------------------------------------------------
 * طبقة الحركة البصرية الإضافية (Premium Motion Layer v3)
 * ---------------------------------------------------------------------------
 * ملف مستقل بالكامل عن js/store/*.js: بيضيف تفاعلات بصرية فوق العناصر
 * الموجودة (مغناطيسية، tilt، خلفية Ambient، نجاح إضافة السلة، نبضة
 * المفضلة) من غير ما يلمس منطق السلة/المفضلة/الطلبات نفسه. لو الملف اتشال
 * أو فشل بأي سبب، الموقع بيشتغل عادي زي ما كان بالظبط.
 * ------------------------------------------------------------------------- */
(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasFinePointer = window.matchMedia('(pointer: fine)').matches;

  /* ─── 1) أزرار مغناطيسية: بتتحرك بخفة نحو الماوس عند الاقتراب ───
   * العناصر الثابتة (مش بتتعاد رسمها) بتتربط مباشرة. أزرار المنتجات
   * (إضافة/مفضلة) بتتغيّر مع كل render، فبنستخدم تفويض الأحداث (delegation)
   * على الحاوية بدل ما نعيد الربط في كل مرة. */
  function wireMagnetic() {
    if (reduceMotion || !hasFinePointer) return;
    document.querySelectorAll('.btn-primary, .btn-ghost, .icon-btn').forEach((el) => {
      el.classList.add('magnetic');
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const x = (e.clientX - r.left - r.width / 2) / (r.width / 2);
        const y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
        el.style.transform = `translate(${x * 10}px, ${y * 10}px)`;
      });
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });
  }

  /* ─── 2) Tilt على بطاقات المنتج + مغناطيسية زر الإضافة/المفضلة داخلها،
   * كلهم عبر تفويض حدث pointermove واحد على الحاوية (يشتغل مع أي render جديد
   * من غير أي إعادة ربط). ─── */
  function wireCardInteractions() {
    if (reduceMotion || !hasFinePointer) return;
    const grid = document.getElementById('productGrid');
    const featured = document.getElementById('featuredScroll');
    [grid, featured].forEach((container) => {
      if (!container) return;
      container.addEventListener('pointermove', (e) => {
        const small = e.target.closest('.add-btn, .wish-toggle');
        if (small) {
          const r = small.getBoundingClientRect();
          const x = (e.clientX - r.left - r.width / 2) / (r.width / 2);
          const y = (e.clientY - r.top - r.height / 2) / (r.height / 2);
          small.style.transform = `translate(${x * 5}px, ${y * 5}px)`;
        }
        const card = e.target.closest('.product-card, .featured-card');
        if (!card) return;
        const r = card.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = `translateY(-6px) perspective(900px) rotateY(${x * 6}deg) rotateX(${-y * 6}deg)`;
      });
      container.addEventListener('pointerout', (e) => {
        const small = e.target.closest('.add-btn, .wish-toggle');
        if (small && !small.contains(e.relatedTarget)) small.style.transform = '';
        const card = e.target.closest('.product-card, .featured-card');
        if (card && !card.contains(e.relatedTarget)) card.style.transform = '';
      });
    });
  }

  /* ─── 3) خلفية Ambient في الـHero بتتبع حركة الماوس بخفة ─── */
  function wireAmbientBlobs() {
    if (reduceMotion || !hasFinePointer) return;
    const hero = document.querySelector('.hero');
    const blobA = hero?.querySelector('.ambient-blob-a');
    const blobB = hero?.querySelector('.ambient-blob-b');
    if (!hero || (!blobA && !blobB)) return;
    hero.addEventListener('pointermove', (e) => {
      const r = hero.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      if (blobA) blobA.style.transform = `translate(${x * 30}px, ${y * 30}px)`;
      if (blobB) blobB.style.transform = `translate(${x * -24}px, ${y * -24}px)`;
    });
    hero.addEventListener('pointerleave', () => {
      if (blobA) blobA.style.transform = '';
      if (blobB) blobB.style.transform = '';
    });
  }

  /* ─── 4) زرار "أضف للسلة": Loading → علامة صح → رجوع طبيعي ─── */
  function wireAddToCartFeedback() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-add], [data-ssr-add], #modalAddBtn');
      if (!btn) return;
      btn.classList.remove('is-success');
      btn.classList.add('is-loading');
      requestAnimationFrame(() => {
        setTimeout(() => {
          btn.classList.remove('is-loading');
          btn.classList.add('is-success');
          setTimeout(() => btn.classList.remove('is-success'), 900);
        }, reduceMotion ? 0 : 160);
      });
    });
  }

  /* ─── 5) قلب المفضلة: نبضة وتوهج راقي بدل تبديل الأيقونة فجأة ─── */
  function wireFavoriteFeedback() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-wish], #modalWishBtn');
      if (!btn) return;
      btn.classList.remove('burst');
      void btn.offsetWidth;
      btn.classList.add('burst');
      setTimeout(() => btn.classList.remove('burst'), 650);
    });
  }

  function init() {
    wireMagnetic();
    wireCardInteractions();
    wireAmbientBlobs();
    wireAddToCartFeedback();
    wireFavoriteFeedback();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
