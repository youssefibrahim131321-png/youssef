/* مُولَّد من admin.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { $, api } from './core.js';
import { go, wireNav } from './nav.js';
import { loadOverview, wireOverview } from './overview.js';
import { wireOrders } from './orders.js';
import { wireProducts } from './products.js';
import { wireCoupons } from './coupons.js';
import { wireBroadcast } from './broadcast.js';
import { wireUsers } from './users.js';
import { wireSettings, loadSettings } from './settings.js';
import { wireProofViewer } from './proof-viewer.js';
import { wireExportLinks } from './export-links.js';
import { wireCommandCenter } from './command-center.js';

/* كل ربط الأحداث بيتنفّذ من هنا بترتيب واضح، بدل ما يكون متناتف في نص الملف. */
wireNav();
wireOverview();
wireOrders();
wireProducts();
wireCoupons();
wireBroadcast();
wireUsers();
wireSettings();
wireProofViewer();
wireExportLinks();
wireCommandCenter();

(async function boot() {
  try {
    const me = await api('/api/auth/me');
    if (!me.loggedIn || me.user.role !== 'admin') { window.location.href = '/admin-login.html'; return; }
    if (me.mustChangePassword) $('#passwordWarning').classList.remove('hidden');
    try { await loadSettings(); } catch (_) { /* الإعدادات مش لازمة لعرض صفحة 2FA */ }
    go(location.hash.slice(1) || 'overview');
    setInterval(() => { if (!document.hidden && (location.hash.slice(1) || 'overview') === 'overview') loadOverview(); }, 60000);
  } catch (error) {
    console.error(error);
  }
})();
