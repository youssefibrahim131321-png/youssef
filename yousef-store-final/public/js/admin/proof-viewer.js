/* عارض إيصالات التحويل داخل لوحة التحكم. */
import { html, setHTML } from './core.js';

export function openProofViewer(url, orderId) {
  if (!url) return;
  const safeUrl = window.YousefUI.safeImageUrl(url);
  if (!safeUrl) return;
  const lastFocused = document.activeElement;
  document.getElementById('proofViewer')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'proofViewer';
  overlay.className = 'proof-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `إيصال تحويل الطلب رقم ${Number(orderId) || ''}`);
  setHTML(overlay, html`
    <div class="proof-lightbox__panel" data-proof-box>
      <header class="proof-lightbox__header">
        <div>
          <span class="proof-lightbox__eyebrow">معاينة المستند</span>
          <h2>إيصال تحويل الطلب #${Number(orderId) || '—'}</h2>
        </div>
        <button type="button" class="proof-lightbox__close" data-proof-close aria-label="إغلاق المعاينة">×</button>
      </header>
      <div class="proof-lightbox__stage" data-proof-stage>
        <img class="proof-lightbox__image" data-proof-image src="${safeUrl}" alt="إيصال تحويل الطلب رقم ${Number(orderId) || ''}">
      </div>
      <footer class="proof-lightbox__footer">
        <div class="proof-lightbox__tools" role="toolbar" aria-label="أدوات صورة الإيصال">
          <button type="button" class="btn btn-ghost btn-sm" data-proof-zoom-out aria-label="تصغير الصورة">−</button>
          <output data-proof-zoom-value>100%</output>
          <button type="button" class="btn btn-ghost btn-sm" data-proof-zoom-in aria-label="تكبير الصورة">+</button>
          <button type="button" class="btn btn-ghost btn-sm" data-proof-zoom-reset>إعادة ضبط</button>
        </div>
        <div class="proof-lightbox__actions">
          <a class="btn btn-primary btn-sm" href="${safeUrl}" download="proof-${Number(orderId) || 'order'}.jpg">تنزيل الإيصال</a>
          <a class="btn btn-ghost btn-sm" href="${safeUrl}" target="_blank" rel="noopener">فتح في تبويب</a>
        </div>
      </footer>
    </div>`);

  const image = overlay.querySelector('[data-proof-image]');
  const zoomValue = overlay.querySelector('[data-proof-zoom-value]');
  let zoom = 1;
  const renderZoom = () => {
    zoom = Math.max(1, Math.min(2.5, zoom));
    image.style.transform = `scale(${zoom})`;
    image.style.cursor = zoom > 1 ? 'zoom-out' : 'zoom-in';
    zoomValue.value = `${Math.round(zoom * 100)}%`;
    zoomValue.textContent = `${Math.round(zoom * 100)}%`;
  };
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === '+' || e.key === '=') { zoom += .25; renderZoom(); }
    if (e.key === '-' || e.key === '_') { zoom -= .25; renderZoom(); }
  };
  overlay.querySelector('[data-proof-close]').addEventListener('click', close);
  overlay.querySelector('[data-proof-zoom-in]').addEventListener('click', () => { zoom += .25; renderZoom(); });
  overlay.querySelector('[data-proof-zoom-out]').addEventListener('click', () => { zoom -= .25; renderZoom(); });
  overlay.querySelector('[data-proof-zoom-reset]').addEventListener('click', () => { zoom = 1; renderZoom(); });
  image.addEventListener('click', () => { zoom = zoom > 1 ? 1 : 1.5; renderZoom(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  renderZoom();
  overlay.querySelector('[data-proof-close]')?.focus();
}

export function wireProofViewer() {
  document.addEventListener('click', (e) => {
    const img = e.target.closest('#modalBody [data-proof], .modal [data-proof]');
    if (img) openProofViewer(img.dataset.proof, img.dataset.proofOrder);
  });
}
