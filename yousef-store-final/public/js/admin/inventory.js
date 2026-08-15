/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, $$, api, toast, money, SETTINGS, html, setHTML } from './core.js';

export async function loadInventory() {
  try {
    const { products } = await api('/api/admin/products');
    const totalValue = products.reduce((sum, p) => sum + p.price * p.stock, 0);
    const outOfStock = products.filter((p) => p.stock === 0).length;
    const low = products.filter((p) => p.stock > 0 && p.stock <= (SETTINGS.lowStockThreshold || 5)).length;
    setHTML($('#inventoryKpis'), [
      ['قيمة المخزون', money(totalValue), '', 'accent'],
      ['نفد من المخزون', outOfStock, 'منتج', 'red'],
      ['مخزون منخفض', low, 'منتج', ''],
      ['إجمالي القطع', products.reduce((s, p) => s + p.stock, 0), 'قطعة', 'blue']
    ].map(([label, value, hint, tone]) => html`<div class="card kpi ${tone}"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`));

    setHTML($('#inventoryBody'), products.sort((a, b) => a.stock - b.stock).map((p) => html`
      <tr>
        <td>${p.name}</td>
        <td class="mono" style="color:${p.stock === 0 ? 'var(--red)' : 'inherit'}">${p.stock}</td>
        <td class="mono">${money(p.price * p.stock)}</td>
        <td>
          <button class="btn btn-ghost btn-sm" data-stock="${p.id}" data-delta="-1">−1</button>
          <button class="btn btn-ghost btn-sm" data-stock="${p.id}" data-delta="1">+1</button>
          <button class="btn btn-ghost btn-sm" data-stock="${p.id}" data-delta="10">+10</button>
        </td>
      </tr>`));
    $$('[data-stock]').forEach((btn) => btn.onclick = async () => {
      try { await api(`/api/admin/products/${btn.dataset.stock}/stock`, { method: 'POST', body: { delta: Number(btn.dataset.delta) } }); loadInventory(); }
      catch (error) { toast(error.message || 'تعذر تحديث المخزون', 'err'); }
    });
  } catch (error) {
    toast(error.message || 'تعذر تحميل المخزون', 'err');
  }
}
