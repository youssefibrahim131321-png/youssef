/* مُولَّد من storefront.js القديم — نفس المنطق، مقسّم لموديولات ES. */
import { wireEffects } from './effects.js';
import { wireAuth, loadUser } from './auth.js';
import { wireNotifications } from './notifications.js';
import { wireCatalog, loadStoreData } from './catalog.js';
import { wireProductModal } from './product-modal.js';
import { wireCart, updateCart } from './cart.js';
import { wireInteractions } from './interactions.js';
import { wireNav } from './nav.js';

/* الربط كله من نقطة واحدة بترتيب واضح. */
wireEffects();
wireAuth();
wireNotifications();
wireCatalog();
wireProductModal();
wireCart();
wireInteractions();
wireNav();

/* ─── Init ─── */
loadStoreData();
loadUser();
updateCart();
