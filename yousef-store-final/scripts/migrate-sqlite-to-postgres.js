#!/usr/bin/env node
/**
 * ---------------------------------------------------------------------------
 * نقل البيانات من store.db (SQLite) لقاعدة Postgres المُدارة.
 * ---------------------------------------------------------------------------
 * الاستخدام:
 *   SQLITE_PATH=./data/store.db DATABASE_URL=postgres://... \
 *     node scripts/migrate-sqlite-to-postgres.js --dry-run
 *   ... ثم بعد مراجعة تقرير الـ dry-run:
 *   node scripts/migrate-sqlite-to-postgres.js --i-have-a-backup
 *
 * ⚠️ خد backup لقاعدة Postgres قبل أول تشغيل حقيقي:
 *      pg_dump "$DATABASE_URL" -Fc -f backup-$(date +%F).dump
 *    السكربت مش هيكتب أي حاجة غير لما تأكد إن عندك backup (بالفلاغ اللي فوق أو
 *    I_HAVE_A_BACKUP=1)، لأن ON CONFLICT DO NOTHING بيمنع تكرار الصفوف لكنه
 *    مش بيرجّع أي بيانات لو الجدول الهدف كان فيه صفوف بنفس المفاتيح.
 *
 * خصائص:
 *   - idempotent: ON CONFLICT DO NOTHING + ضبط الـ sequences في الآخر.
 *   - ترتيب الجداول واعي بالمفاتيح الأجنبية (الأب قبل الابن) عشان ما يفشلش FK.
 *   - كل النقل جوّه transaction واحدة: يا كله يا ولا حاجة.
 *   - إدخال على دفعات (batch) بدل صف-بصف: أسرع بمراحل على قواعد كبيرة.
 *   - --dry-run: يقرأ SQLite ويطابق الأعمدة ويطبع تقرير بدون أي كتابة.
 * ---------------------------------------------------------------------------
 */
const path = require('path');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run') || process.env.DRY_RUN === '1';
const BACKUP_OK = args.has('--i-have-a-backup') || process.env.I_HAVE_A_BACKUP === '1';
const BATCH_SIZE = Math.max(1, Number(process.env.BATCH_SIZE || 500));

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(process.cwd(), 'data', 'store.db');
const DATABASE_URL = process.env.DATABASE_URL;
const IS_CLI = require.main === module;
if (IS_CLI && !DATABASE_URL) { console.error('لازم تظبط DATABASE_URL'); process.exit(1); }

if (IS_CLI && !DRY_RUN && !BACKUP_OK) {
  console.error([
    '⛔ ممنوع النقل بدون تأكيد الـ backup.',
    '',
    '1) خد نسخة احتياطية:',
    '     pg_dump "$DATABASE_URL" -Fc -f backup-$(date +%F).dump',
    '2) شوف الأول إيه اللي هيتنقل (من غير كتابة):',
    '     node scripts/migrate-sqlite-to-postgres.js --dry-run',
    '3) بعدها شغّل النقل الحقيقي:',
    '     node scripts/migrate-sqlite-to-postgres.js --i-have-a-backup'
  ].join('\n'));
  process.exit(1);
}

/** أسماء الجداول/الأعمدة بتتحقن في SQL، فلازم تتحقق قبل أي استخدام. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const q = (name) => {
  if (!IDENT.test(name)) throw new Error(`اسم غير صالح في المخطط: ${name}`);
  return `"${name}"`;
};

/**
 * ترتيب طوبولوجي للجداول حسب المفاتيح الأجنبية في Postgres (الأب الأول).
 * لو فيه دورة (جدولين بيرجعوا لبعض) بنرجّع الباقي بترتيبه الأصلي — الـ
 * transaction والـ DEFERRABLE بيكملوا الباقي.
 */
async function orderByDependencies(client, tables) {
  const { rows } = await client.query(`
    SELECT src.relname AS child, tgt.relname AS parent
    FROM pg_constraint c
    JOIN pg_class src ON src.oid = c.conrelid
    JOIN pg_class tgt ON tgt.oid = c.confrelid
    WHERE c.contype = 'f'
  `);
  const set = new Set(tables);
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of rows) {
    if (child === parent) continue; // self-reference: مش بيأثر على ترتيب الجداول
    if (set.has(child) && set.has(parent)) deps.get(child).add(parent);
  }
  const out = [];
  const placed = new Set();
  let guard = tables.length + 1;
  while (out.length < tables.length && guard-- > 0) {
    for (const t of tables) {
      if (placed.has(t)) continue;
      if ([...deps.get(t)].every((p) => placed.has(p))) { out.push(t); placed.add(t); }
    }
  }
  for (const t of tables) if (!placed.has(t)) out.push(t); // دورة: بترتيبها الأصلي
  return out;
}

/** إدخال دفعة صفوف بجملة INSERT واحدة مالتي-فاليو. */
async function insertBatch(client, table, keys, batch) {
  const cols = keys.map(q).join(', ');
  const params = [];
  const tuples = batch.map((row) => {
    const ph = keys.map((k) => { params.push(row[k]); return `$${params.length}`; });
    return `(${ph.join(', ')})`;
  });
  const res = await client.query(
    `INSERT INTO ${q(table)} (${cols}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
    params
  );
  return res.rowCount || 0;
}

async function main() {
  // require متأخر عشان الاختبارات تستورد الدوال المساعدة من غير ما تفتح قاعدة.
  const Database = require('better-sqlite3');
  const { Pool } = require('pg');
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSL === '0' ? false : { rejectUnauthorized: false }
  });
  const sqliteTables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((n) => IDENT.test(n));

  const client = await pool.connect();
  let started = false;
  const report = [];
  try {
    const tables = await orderByDependencies(client, sqliteTables);
    console.log(`${DRY_RUN ? '🔎 dry-run' : '🚚 نقل'} — ${tables.length} جدول بترتيب المفاتيح الأجنبية:\n  ${tables.join(' → ')}\n`);

    if (!DRY_RUN) { await client.query('BEGIN'); started = true; }

    for (const table of tables) {
      const { rows: cols } = await client.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
        [table]
      );
      if (!cols.length) { console.log(`- تخطّي ${table} (مش موجود في Postgres)`); report.push({ table, skipped: true }); continue; }
      const allowed = new Set(cols.map((c) => c.column_name));

      const data = sqlite.prepare(`SELECT * FROM ${q(table)}`).all();
      const sqliteCols = data.length ? Object.keys(data[0]) : [];
      const dropped = sqliteCols.filter((k) => !allowed.has(k));
      if (dropped.length) console.log(`  ⓘ ${table}: أعمدة مش موجودة في Postgres هتتجاهل: ${dropped.join(', ')}`);

      let inserted = 0;
      if (data.length) {
        const keys = sqliteCols.filter((k) => allowed.has(k));
        if (!keys.length) { console.log(`- تخطّي ${table} (مفيش أعمدة مشتركة)`); report.push({ table, skipped: true }); continue; }
        if (!DRY_RUN) {
          for (let i = 0; i < data.length; i += BATCH_SIZE) {
            inserted += await insertBatch(client, table, keys, data.slice(i, i + BATCH_SIZE));
          }
        }
      }
      console.log(DRY_RUN
        ? `✔ ${table}: ${data.length} صف جاهزين للنقل (بدون كتابة)`
        : `✔ ${table}: ${inserted} صف جديد من ${data.length}`);
      report.push({ table, rows: data.length, inserted, dropped });

      if (!DRY_RUN && allowed.has('id')) {
        // setval بيفشل لو العمود مش serial/identity — مش خطأ يوقف النقل.
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${q(table)}), 1), 1), true)`,
          [table]
        ).catch((e) => console.log(`  ⓘ ${table}: مفيش sequence لـ id (${e.message})`));
      }
    }

    if (!DRY_RUN) { await client.query('COMMIT'); started = false; }
    const total = report.reduce((s, r) => s + (r.rows || 0), 0);
    console.log(DRY_RUN
      ? `\n🔎 dry-run خلص: ${total} صف كانوا هيتنقلوا. شغّل بـ --i-have-a-backup بعد الـ backup.`
      : `\n✅ خلص النقل (${total} صف مقروء من SQLite).`);
  } catch (err) {
    if (started) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

module.exports = { orderByDependencies, insertBatch, quoteIdent: q, IDENT };

if (require.main === module) {
  main().catch((err) => { console.error('❌ فشل النقل (اترجع كل حاجة):', err.message); process.exit(1); });
}
