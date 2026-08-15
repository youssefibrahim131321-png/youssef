/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, $$, api, toast, money, openModal, html, setHTML } from './core.js';

export let USERS = [];
export async function loadUsers() {
  try {
    const { users } = await api('/api/admin/users');
    USERS = users;
    renderUsers();
  } catch (error) {
    toast(error.message || 'تعذر تحميل المستخدمين', 'err');
  }
}
export function renderUsers() {
  const q = $('#userSearch').value.trim().toLowerCase();
  const list = USERS.filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q));
  setHTML($('#usersBody'), list.map((u) => html`
    <tr>
      <td class="mono">#${u.id}</td>
      <td>${u.name}</td>
      <td class="mono">${u.email}</td>
      <td class="mono">${u.phone || '—'}</td>
      <td><span class="chip ${u.role === 'admin' ? 'confirmed' : 'done'}">${u.role === 'admin' ? 'مسؤول' : 'عميل'}</span></td>
      <td class="mono">${Number(u.orders_count || 0)}</td>
      <td class="mono">${money(u.total_spent)}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-edit-user="${u.id}">تعديل</button>
        <button class="btn btn-danger btn-sm" data-del-user="${u.id}">حذف</button>
      </td>
    </tr>`));
  $$('[data-edit-user]').forEach((btn) => btn.onclick = () => userForm(USERS.find((u) => u.id === Number(btn.dataset.editUser))));
  $$('[data-del-user]').forEach((btn) => btn.onclick = async () => {
    if (!confirm('حذف المستخدم نهائيًا؟')) return;
    try { await api(`/api/admin/users/${btn.dataset.delUser}`, { method: 'DELETE' }); toast('تم الحذف'); loadUsers(); }
    catch (error) { toast(error.message, 'err'); }
  });
}

export function wireUsers() {
$('#userSearch').oninput = renderUsers;
$('#addUserBtn').onclick = () => userForm(null);
}

export function userForm(user) {
  const u = user || {};
  openModal(user ? `تعديل: ${u.name}` : 'مستخدم جديد', html`
    <div class="field"><label>الاسم</label><input name="name" required value="${u.name || ''}"></div>
    <div class="field"><label>البريد الإلكتروني</label><input name="email" type="email" required value="${u.email || ''}"></div>
    <div class="field"><label>الهاتف</label><input name="phone" value="${u.phone || ''}"></div>
    <div class="field"><label>${user ? 'كلمة مرور جديدة (اختياري)' : 'كلمة المرور'}</label><input name="password" type="password" ${user ? '' : 'required'} minlength="8"></div>
    <div class="field"><label>الصلاحية</label><select name="role">
      <option value="customer" ${u.role !== 'admin' ? 'selected' : ''}>عميل</option>
      <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>مسؤول</option></select></div>
    <div class="field"><label>كلمة مرورك أنت (مطلوبة عند منح صلاحية مسؤول أو تغيير كلمة مرور مستخدم آخر)</label>
      <input name="currentPassword" type="password" autocomplete="current-password" placeholder="تأكيد هويتك"></div>
  `, async (values) => {
    if (!values.password) delete values.password;
    if (!values.currentPassword) delete values.currentPassword;
    if (user) await api(`/api/admin/users/${user.id}`, { method: 'PUT', body: values });
    else await api('/api/admin/users', { method: 'POST', body: values });
    toast('تم الحفظ'); loadUsers();
  });
}
