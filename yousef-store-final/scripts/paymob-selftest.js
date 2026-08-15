/**
 * scripts/paymob-selftest.js — اختبار سريع لدالة verifyHmac على مثال ثابت،
 * بدون أي اتصال شبكة حقيقي بـ Paymob. شغّله بـ: node scripts/paymob-selftest.js
 */
process.env.PAYMOB_HMAC_SECRET = 'test-secret';
const crypto = require('crypto');
const { verifyHmac, HMAC_FIELDS } = require('../lib/paymob');

const fixtureObj = {
  amount_cents: '10000',
  created_at: '2024-01-01T00:00:00Z',
  currency: 'EGP',
  error_occured: 'false',
  has_parent_transaction: 'false',
  id: '123456',
  integration_id: '1',
  is_3d_secure: 'true',
  is_auth: 'false',
  is_capture: 'false',
  is_refunded: 'false',
  is_standalone_payment: 'true',
  is_voided: 'false',
  order: { id: '999' },
  owner: '55',
  pending: 'false',
  source_data: { pan: '1234', sub_type: 'MasterCard', type: 'card' },
  success: 'true'
};

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}
const concatenated = HMAC_FIELDS.map((f) => String(getPath(fixtureObj, f) ?? '')).join('');
const validHmac = crypto.createHmac('sha512', 'test-secret').update(concatenated).digest('hex');

let pass = true;

if (verifyHmac({ obj: fixtureObj }, validHmac) !== true) {
  console.error('FAIL: توقيع صحيح اتقبل غلط'); pass = false;
} else {
  console.log('PASS: توقيع صحيح اتقبل');
}

if (verifyHmac({ obj: fixtureObj }, 'وهمي') !== false) {
  console.error('FAIL: توقيع غلط اتقبل'); pass = false;
} else {
  console.log('PASS: توقيع غلط اترفض');
}

if (verifyHmac({ obj: fixtureObj }, '') !== false) {
  console.error('FAIL: توقيع فاضي اتقبل'); pass = false;
} else {
  console.log('PASS: توقيع فاضي اترفض');
}

if (pass) { console.log('\n✅ PASS — كل اختبارات verifyHmac نجحت'); process.exit(0); }
else { console.error('\n❌ FAIL'); process.exit(1); }
