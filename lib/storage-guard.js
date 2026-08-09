/**
 * (إصلاح 2 و 6) حماية التخزين:
 *  - على منصة سحابية مع NODE_ENV=production: لو DATA_DIR/UPLOADS_DIR مش على
 *    Volume دائم، السيرفر بيقف فورًا بدل ما ينشر متجر بيمسح بياناته مع أول
 *    إعادة نشر. تقدر تتجاوز بوعي عبر ALLOW_EPHEMERAL_STORAGE=1.
 *  - النسخ الاحتياطي لازم يكون على مسار مختلف عن قاعدة البيانات (BACKUP_DIR)
 *    وإلا بنحذّر إن دي مش نسخة احتياطية حقيقية.
 *  - قفل instance واحد: SQLite ملف واحد = عملية واحدة. لو لقينا قفل حي على
 *    نفس مجلد البيانات بنمنع التشغيل المزدوج بدل ما البيانات تتلخبط.
 */
const fs = require('fs');
const path = require('path');

// أي تشغيل production بيتعامل كأنه استضافة قابلة لمسح القرص: Docker/VM عادية
// بتضيّع البيانات مع إعادة البناء بالضبط زي Railway/Render. لو التخزين فعلًا
// دائم على سيرفرك، فعّل ALLOW_EPHEMERAL_STORAGE=1 بوعي.
function onCloudHost() {
  return true;
}

function isInsideProject(dir, projectRoot) {
  const rel = path.relative(projectRoot, path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function checkStorage({ projectRoot, dataDir, uploadsDir, backupDir, logger = console }) {
  const problems = [];
  if (isInsideProject(dataDir, projectRoot)) problems.push('DATA_DIR جوه مجلد المشروع');
  if (isInsideProject(uploadsDir, projectRoot)) problems.push('UPLOADS_DIR جوه مجلد المشروع');
  if (path.resolve(backupDir) === path.resolve(dataDir) || isInsideProject(backupDir, path.resolve(dataDir))) {
    problems.push('النسخ الاحتياطي على نفس مسار قاعدة البيانات (مش نسخة احتياطية حقيقية) — ظبّط BACKUP_DIR');
  }

  if (!problems.length) return { ok: true, problems, fatal: false };

  const fatal = onCloudHost() && process.env.NODE_ENV === 'production'
    && process.env.ALLOW_EPHEMERAL_STORAGE !== '1'
    && (isInsideProject(dataDir, projectRoot) || isInsideProject(uploadsDir, projectRoot));

  const message = [
    '⚠️  خطر فقدان بيانات:',
    ...problems.map((p) => `    - ${p}`),
    '    اعمل Volume دائم وظبّط: DATA_DIR=/data و UPLOADS_DIR=/data/uploads/products و BACKUP_DIR=/backups',
    fatal ? '    ⛔ تم إيقاف التشغيل لحماية بياناتك. للتجاوز بوعي: ALLOW_EPHEMERAL_STORAGE=1' : ''
  ].filter(Boolean).join('\n');

  (fatal ? logger.error : logger.warn)(`\x1b[33m${message}\x1b[0m`);
  return { ok: false, problems, fatal, message };
}

/** قفل تشغيل نسخة واحدة على نفس مجلد البيانات. */
function acquireInstanceLock(dataDir, { logger = console } = {}) {
  const lockPath = path.join(dataDir, 'instance.lock');
  try {
    if (fs.existsSync(lockPath)) {
      const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (_) { alive = false; }
      if (alive && pid !== process.pid) {
        logger.error(`\x1b[31m⛔ في نسخة تانية من السيرفر شغالة (PID ${pid}) على نفس مجلد البيانات. SQLite ملف واحد = instance واحد. لو محتاج scaling اتحوّل لـ PostgreSQL/Redis.\x1b[0m`);
        return { ok: false, pid, release: () => {} };
      }
    }
    fs.writeFileSync(lockPath, String(process.pid));
    const release = () => { try { fs.unlinkSync(lockPath); } catch (_) { /* لا شيء */ } };
    return { ok: true, pid: process.pid, release };
  } catch (error) {
    logger.warn('[storage-guard] تعذر إنشاء قفل التشغيل:', error.message);
    return { ok: true, pid: process.pid, release: () => {} };
  }
}

module.exports = { checkStorage, acquireInstanceLock, onCloudHost, isInsideProject };
