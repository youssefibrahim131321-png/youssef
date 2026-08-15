#!/usr/bin/env node
/**
 * استعادة حساب الأدمن من غير ما تمسح قاعدة البيانات (نسخة PostgreSQL/async).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createStore } = require('../store');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

async function main() {
  const store = await createStore(path.join(DATA_DIR, 'store.json'));
  const explicit = process.argv[2];
  const password = explicit && explicit.length >= 8 ? explicit : crypto.randomBytes(12).toString('base64url');
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

  const admins = (await store.getUsers()).filter((u) => u.role === 'admin');
  if (!admins.length) {
    console.error('مفيش حساب أدمن في قاعدة البيانات. شغّل السيرفر مرة واحدة عشان يتعمل تلقائيًا.');
    process.exit(1);
  }
  const target = email ? admins.find((u) => String(u.email).toLowerCase() === email) : admins[0];
  if (!target) {
    console.error(`مفيش أدمن بالبريد ${email}. الحسابات المتاحة: ${admins.map((u) => u.email).join(', ')}`);
    process.exit(1);
  }

  await store.setUserPassword(target.id, password);
  await store.bumpSessionVersion(target.id);
  // (إصلاح 4) دلوقتي TOTP شغّال فعليًا: لو الأدمن ضيّع كلمة السر وجهاز
  // المصادقة مع بعض، استعادة الباسورد لوحدها هتسيبه قافل برا حسابه. السكربت
  // ده بيتشغّل يدويًا من حد له وصول للسيرفر أصلًا، فمنطقي يشيل التفعيل كمان.
  await store.disableTotp(target.id);
  try { fs.unlinkSync(path.join(DATA_DIR, 'INITIAL-ADMIN-PASSWORD.txt')); } catch (_) { /* لا شيء */ }
  await store.flush();

  console.log('\n✅ تم تغيير كلمة مرور المسؤول، وإلغاء التحقق بخطوتين لو كان مفعّل، وتسجيل الخروج من كل الأجهزة.');
  console.log(`   البريد: ${target.email}`);
  console.log(`   كلمة المرور الجديدة: ${password}`);
  console.log('   سجّل دخول فورًا وغيّرها من لوحة التحكم.\n');
  await store.pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
