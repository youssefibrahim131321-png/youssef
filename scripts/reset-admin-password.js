#!/usr/bin/env node
/**
 * (إصلاح 3) استعادة حساب الأدمن من غير ما تمسح قاعدة البيانات.
 * الاستخدام:
 *   npm run admin:reset-password                 # يولّد كلمة مرور قوية ويطبعها
 *   npm run admin:reset-password -- "كلمة-سرك"    # يستخدم كلمة مرور من عندك
 *   ADMIN_EMAIL=you@mail.com npm run admin:reset-password
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createStore } = require('../store');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const store = createStore(path.join(DATA_DIR, 'store.json'));

const explicit = process.argv[2];
const password = explicit && explicit.length >= 8 ? explicit : crypto.randomBytes(12).toString('base64url');
const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

const admins = store.getUsers().filter((u) => u.role === 'admin');
if (!admins.length) {
  console.error('مفيش حساب أدمن في قاعدة البيانات. شغّل السيرفر مرة واحدة عشان يتعمل تلقائيًا.');
  process.exit(1);
}
const target = email ? admins.find((u) => String(u.email).toLowerCase() === email) : admins[0];
if (!target) {
  console.error(`مفيش أدمن بالبريد ${email}. الحسابات المتاحة: ${admins.map((u) => u.email).join(', ')}`);
  process.exit(1);
}

store.setUserPassword(target.id, password);
store.bumpSessionVersion(target.id);
try { fs.unlinkSync(path.join(DATA_DIR, 'INITIAL-ADMIN-PASSWORD.txt')); } catch (_) { /* لا شيء */ }
store.flush();

console.log('\n✅ تم تغيير كلمة مرور المسؤول وتسجيل الخروج من كل الأجهزة.');
console.log(`   البريد: ${target.email}`);
console.log(`   كلمة المرور الجديدة: ${password}`);
console.log('   سجّل دخول فورًا وغيّرها من لوحة التحكم.\n');
