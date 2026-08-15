/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { html } from './core.js';
/* كل النصوص/الألوان الثابتة في مكان واحد. */
export /* ============================ التنقل ============================ */
const PAGE_META = {
  overview: ['نظرة عامة', 'ملخص أداء المتجر اليوم'],
  orders: ['الطلبات', 'إدارة ومتابعة كل الطلبات'],
  products: ['المنتجات', 'إضافة وتعديل منتجات المتجر'],
  inventory: ['المخزون', 'متابعة الكميات وقيمة المخزون'],
  coupons: ['الكوبونات', 'أكواد الخصم والعروض'],
  reviews: ['التقييمات', 'مراجعة تقييمات العملاء'],
  broadcast: ['إشعار جماعي', 'أرسل رسالة لكل العملاء دفعة واحدة'],
  users: ['المستخدمون', 'العملاء والمسؤولون'],
  activity: ['سجل النشاط', 'كل ما تم داخل لوحة التحكم'],
  settings: ['الإعدادات', 'بيانات المتجر والشحن والأمان']
};

export const STATUS_LABELS = { pending: 'قيد الانتظار', confirmed: 'مؤكد', shipping: 'في الطريق', done: 'تم التسليم', cancelled: 'ملغي' };
// (إصلاح ثيم فاتح) الألوان بقت متغيرات CSS بتتبدّل مع الثيم بدل قيم ثابتة
// كانت مقروءة على الغامق بس.
export const STATUS_COLORS = {
  pending: 'var(--status-pending)',
  confirmed: 'var(--status-confirmed)',
  shipping: 'var(--status-shipping)',
  done: 'var(--status-done)',
  cancelled: 'var(--status-cancelled)'
};
export const statusChip = (status) => html`<span class="chip ${status}">${STATUS_LABELS[status] || status}</span>`;

export const PAYMENT_LABELS = {
  'cash-on-delivery': 'الدفع عند الاستلام',
  'vodafone-cash': 'فودافون كاش',
  'instapay': 'إنستاباي',
  'whatsapp': 'تأكيد عبر واتساب'
};
export const paymentLabel = (m) => PAYMENT_LABELS[m] || m || 'غير محدد';

export const PAYMENT_ICONS = { 'cash-on-delivery': '💵', 'vodafone-cash': '📱', 'instapay': '🏦', 'whatsapp': '💬' };
