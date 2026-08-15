require('./helpers/test-db'); // قاعدة بيانات اختبارات معزولة في الذاكرة (لازم قبل store/server)
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const guard = require('../lib/storage-guard');

const silent = { warn() {}, error() {} };

test('flags data and uploads inside the project folder', () => {
  const root = '/app';
  const res = guard.checkStorage({
    projectRoot: root, dataDir: '/app/data', uploadsDir: '/app/public/uploads', backupDir: '/app/data/backups', logger: silent
  });
  assert.strictEqual(res.ok, false);
  assert.ok(res.problems.length >= 3);
});

test('accepts a real volume with separate backups', () => {
  const res = guard.checkStorage({
    projectRoot: '/app', dataDir: '/data', uploadsDir: '/data/uploads/products', backupDir: '/backups', logger: silent
  });
  assert.strictEqual(res.ok, true);
});

test('instance lock prevents a second live process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-lock-'));
  const first = guard.acquireInstanceLock(dir, { logger: silent });
  assert.strictEqual(first.ok, true);
  fs.writeFileSync(path.join(dir, 'instance.lock'), String(process.ppid || process.pid));
  const second = guard.acquireInstanceLock(dir, { logger: silent });
  assert.strictEqual(second.ok, process.ppid ? false : true);
  first.release();
});
