#!/usr/bin/env node
/**
 * فحص تشغيلي خفيف يمكن تشغيله دوريًا:
 *   STORE_URL=https://example.com node scripts/automation-health.js
 * أو عبر npm run automation:health
 */
const base = String(process.env.STORE_URL || `http://127.0.0.1:${process.env.PORT || 4173}`).replace(/\/$/, '');
const timeoutMs = Number(process.env.HEALTH_TIMEOUT_MS || 8000);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

async function main() {
  const health = await fetch(`${base}/api/health`, { signal: controller.signal, headers: { accept: 'application/json' } });
  if (!health.ok) throw new Error(`health returned ${health.status}`);
  const config = await fetch(`${base}/api/config`, { signal: controller.signal, headers: { accept: 'application/json' } });
  if (!config.ok) throw new Error(`config returned ${config.status}`);
  const body = await config.json().catch(() => ({}));
  console.log(JSON.stringify({ ok: true, url: base, paymobEnabled: !!body.paymobEnabled, checkedAt: new Date().toISOString() }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, url: base, error: error.name === 'AbortError' ? 'timeout' : error.message, checkedAt: new Date().toISOString() }));
  process.exitCode = 1;
}).finally(() => clearTimeout(timer));
