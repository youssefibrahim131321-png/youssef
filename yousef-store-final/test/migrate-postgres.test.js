/**
 * اختبار منطق سكربت الهجرة (ترتيب المفاتيح الأجنبية + بناء الـ INSERT
 * والدفعات) على عميل Postgres مزيّف — لأن مفيش سيرفر Postgres في CI.
 * المسار الحقيقي على قاعدة قديمة بيتجرّب بـ --dry-run (شوف MIGRATION.md).
 */
require('./helpers/test-db'); // قاعدة بيانات اختبارات معزولة في الذاكرة (لازم قبل store/server)
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'migrate-sqlite-to-postgres.js');
const { orderByDependencies, insertBatch, quoteIdent } = require(SCRIPT);

function fakeClient(fkRows) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      if (/pg_constraint/.test(sql)) return { rows: fkRows };
      return { rows: [], rowCount: params ? params.length : 0 };
    }
  };
}

test('الأب قبل الابن في ترتيب النقل', async () => {
  const client = fakeClient([
    { child: 'order_items', parent: 'orders' },
    { child: 'orders', parent: 'users' },
    { child: 'reviews', parent: 'products' },
    { child: 'order_items', parent: 'products' }
  ]);
  const order = await orderByDependencies(client, ['order_items', 'reviews', 'orders', 'users', 'products']);
  const at = (t) => order.indexOf(t);
  assert.ok(at('users') < at('orders'));
  assert.ok(at('orders') < at('order_items'));
  assert.ok(at('products') < at('order_items'));
  assert.ok(at('products') < at('reviews'));
  assert.strictEqual(order.length, 5);
});

test('الدورة بين جدولين ما بتعلّقش السكربت', async () => {
  const client = fakeClient([{ child: 'a', parent: 'b' }, { child: 'b', parent: 'a' }]);
  const order = await orderByDependencies(client, ['a', 'b']);
  assert.deepStrictEqual([...order].sort(), ['a', 'b']);
});

test('المرجع الذاتي مش بيمنع الجدول من الترتيب', async () => {
  const client = fakeClient([{ child: 'categories', parent: 'categories' }]);
  assert.deepStrictEqual(await orderByDependencies(client, ['categories']), ['categories']);
});

test('INSERT على دفعات بيبني placeholders صح مع ON CONFLICT DO NOTHING', async () => {
  const client = fakeClient([]);
  const rows = [{ id: 1, name: 'أ' }, { id: 2, name: 'ب' }];
  await insertBatch(client, 'products', ['id', 'name'], rows);
  const { sql, params } = client.queries[0];
  assert.match(sql, /INSERT INTO "products" \("id", "name"\) VALUES \(\$1, \$2\), \(\$3, \$4\) ON CONFLICT DO NOTHING/);
  assert.deepStrictEqual(params, [1, 'أ', 2, 'ب']);
});

test('أسماء جداول/أعمدة مش صالحة بتترفض (منع حقن SQL)', () => {
  assert.strictEqual(quoteIdent('order_items'), '"order_items"');
  for (const bad of ['users; DROP TABLE x', 'a"b', '1abc', 'a b']) {
    assert.throws(() => quoteIdent(bad), /اسم غير صالح/);
  }
});

test('بيرفض النقل الحقيقي من غير تأكيد backup', () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DATABASE_URL: 'postgres://x/y', DRY_RUN: '', I_HAVE_A_BACKUP: '' },
    encoding: 'utf8'
  });
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /ممنوع النقل بدون تأكيد الـ backup/);
  assert.match(res.stderr, /pg_dump/);
});
