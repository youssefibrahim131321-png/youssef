/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, $$, safeImageUrl, api, toast, money, openModal, isValidImageUrl, html, setHTML, trustedHtml } from './core.js';
import { compressImage } from './image-compress.js';

export let PRODUCTS = [];
export async function loadProducts() {
  try {
    const data = await api('/api/admin/products');
    PRODUCTS = data.products;
    const categories = [...new Set(PRODUCTS.map((p) => p.category))];
    const filter = $('#productCategoryFilter');
    setHTML(filter, html`<option value="all">كل الأقسام</option>${categories.map((c) => html`<option>${c}</option>`)}`);
    renderProducts();
  } catch (error) {
    toast(error.message || 'تعذر تحميل المنتجات', 'err');
  }
}
export function renderProducts() {
  const q = $('#productSearch').value.trim().toLowerCase();
  const category = $('#productCategoryFilter').value;
  const list = PRODUCTS.filter((p) => (category === 'all' || p.category === category)
    && (!q || `${p.name} ${p.category} ${p.sku}`.toLowerCase().includes(q)));
  setHTML($('#productsBody'), list.length ? list.map((p) => html`
    <tr>
      <td><img class="thumb" width="44" height="44" loading="lazy" alt="" data-img-id="${p.id}"></td>
      <td>${p.name}<br><small class="muted mono">${p.sku || ''}</small></td>
      <td>${p.category}</td>
      <td class="mono">${money(p.price)}${p.old_price ? html`<br><small class="muted"><del>${money(p.old_price)}</del></small>` : ''}</td>
      <td class="mono" style="color:${p.stock === 0 ? 'var(--red)' : p.stock <= 5 ? 'var(--accent)' : 'inherit'}">${p.stock}</td>
      <td class="mono">${Number(p.sold || 0)}</td>
      <td>${p.rating ? `⭐ ${Number(p.rating)} (${Number(p.reviews_count || 0)})` : '—'}</td>
      <td><span class="chip ${p.active ? 'done' : 'cancelled'}">${p.active ? 'نشط' : 'مخفي'}</span></td>
      <td>
        <button class="btn btn-ghost btn-sm" data-edit="${p.id}">تعديل</button>
        <button class="btn btn-danger btn-sm" data-del="${p.id}">حذف</button>
      </td>
    </tr>`) : trustedHtml('<tr><td colspan="9" class="empty">لا توجد منتجات مطابقة</td></tr>'));
  // (أمان) رابط صورة المنتج بيتحط عبر setAttribute بدل تضمينه جوّه سلسلة innerHTML.
  $('#productsBody').querySelectorAll('img[data-img-id]').forEach((img) => {
    const p = list.find((x) => x.id === Number(img.dataset.imgId));
    if (p) img.setAttribute('src', safeImageUrl(p.image_url));
  });
  $$('[data-edit]').forEach((btn) => btn.onclick = () => productForm(PRODUCTS.find((p) => p.id === Number(btn.dataset.edit))));
  $$('[data-del]').forEach((btn) => btn.onclick = async () => {
    if (!confirm('تأكيد حذف المنتج؟')) return;
    try { await api(`/api/admin/products/${btn.dataset.del}`, { method: 'DELETE' }); toast('تم حذف المنتج'); loadProducts(); }
    catch (error) { toast(error.message || 'تعذر حذف المنتج', 'err'); }
  });
}

export function wireProducts() {
$('#productSearch').oninput = renderProducts;
$('#productCategoryFilter').onchange = renderProducts;
$('#addProductBtn').onclick = () => productForm(null);
}

export function productForm(product) {
  const p = product || {};
  openModal(product ? `تعديل: ${p.name}` : 'منتج جديد', html`
    <div class="row">
      <div class="field"><label>اسم المنتج</label><input name="name" required value="${p.name || ''}"></div>
      <div class="field"><label>القسم</label><input name="category" required value="${p.category || ''}" list="catList">
        <datalist id="catList">${[...new Set(PRODUCTS.map((x) => x.category))].map((c) => html`<option>${c}</option>`)}</datalist></div>
    </div>
    <div class="row">
      <div class="field"><label>السعر</label><input name="price" type="number" min="0" step="0.01" required value="${p.price ?? ''}"></div>
      <div class="field"><label>السعر قبل الخصم</label><input name="oldPrice" type="number" min="0" value="${p.old_price ?? ''}"></div>
      <div class="field"><label>المخزون</label><input name="stock" type="number" min="0" value="${p.stock ?? 0}"></div>
    </div>
    <div class="row">
      <div class="field"><label>الكود SKU</label><input name="sku" value="${p.sku || ''}"></div>
      <div class="field"><label>الوسم</label><input name="tag" value="${p.tag || ''}" placeholder="عرض / جديد"></div>
    </div>
    <div class="field"><label>صورة المنتج</label>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <img id="imgPreview" src="${p.image_url || ''}" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid #ddd;${p.image_url ? '' : 'display:none;'}">
        <input type="file" id="productImageFile" accept="image/png,image/jpeg,image/webp">
        <span id="uploadStatus" style="font-size:13px;color:#888"></span>
      </div>
      <input name="imageUrl" id="productImageUrl" value="${p.image_url || ''}" placeholder="ارفع صورة من جهازك، أو الصق رابط صورة (يبدأ بـ https:// أو /uploads/)">
      <small style="color:#888;font-size:12px">مسموح فقط بروابط تبدأ بـ https:// أو http:// أو مسار داخلي مثل /uploads/products/img.jpg</small>
    </div>
    <div class="field"><label>الوصف</label><textarea name="description" rows="3">${p.description || ''}</textarea></div>
    <div class="row">
      <div class="field"><label>الحالة</label><select name="active"><option value="1" ${(p.active !== 0 && p.active !== false) ? 'selected' : ''}>نشط</option><option value="0" ${(p.active === 0 || p.active === false) ? 'selected' : ''}>مخفي</option></select></div>
      <div class="field"><label>مميز في الصفحة الرئيسية</label><select name="featured"><option value="0" ${!p.featured ? 'selected' : ''}>لا</option><option value="1" ${p.featured ? 'selected' : ''}>نعم</option></select></div>
    </div>
  `, async (values) => {
    values.active = Number(values.active);
    values.featured = Number(values.featured);
    // (أمان) تحقق من شكل رابط الصورة قبل الإرسال — نفس التحقق بيتعاد على السيرفر.
    const imageValue = String(values.imageUrl || '').trim();
    if (imageValue && !isValidImageUrl(imageValue)) {
      toast('رابط الصورة غير صالح. لازم يبدأ بـ https:// أو http:// أو / ومن غير مسافات أو علامات تنصيص.', 'err');
      return;
    }
    values.imageUrl = imageValue;
    if (product) await api(`/api/admin/products/${product.id}`, { method: 'PUT', body: values });
    else await api('/api/admin/products', { method: 'POST', body: values });
    toast(product ? 'تم تحديث المنتج' : 'تمت إضافة المنتج');
    loadProducts();
  });
  $('#productImageFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = $('#uploadStatus');
    statusEl.textContent = 'جارٍ ضغط الصورة...';
    statusEl.style.color = '#888';
    try {
      const optimized = await compressImage(file);
      statusEl.textContent = 'جارٍ رفع الصورة...';
      const fd = new FormData();
      fd.append('image', optimized, optimized.name);
      const res = await fetch('/api/admin/upload-image', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) { window.location.href = '/admin-login.html'; return; }
      if (!res.ok) throw new Error(data.error || 'تعذر رفع الصورة');
      $('#productImageUrl').value = data.url;
      $('#imgPreview').src = data.url;
      $('#imgPreview').style.display = '';
      statusEl.textContent = 'تم رفع الصورة بنجاح ✅';
    } catch (error) {
      statusEl.textContent = `خطأ: ${error.message}`;
      statusEl.style.color = '#e05252';
    }
  };
}
