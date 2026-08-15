#!/usr/bin/env node
// مولّد تقرير الجودة التلقائي.
// بيشغّل: lint + typecheck + XSS audit + الاختبارات، وبيكتب تقرير Markdown محدّث.
// الاستخدام: node tools/ci-report.js [--out CI-REPORT.md]

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const outArgIndex = process.argv.indexOf('--out');
const outFile = path.resolve(
  process.cwd(),
  outArgIndex !== -1 ? process.argv[outArgIndex + 1] : 'CI-REPORT.md',
);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const CHECKS = [
  { id: 'lint', title: 'ESLint', cmd: npmCmd, args: ['run', '--silent', 'lint'] },
  { id: 'typecheck', title: 'فحص البناء (typecheck)', cmd: npmCmd, args: ['run', '--silent', 'typecheck'] },
  { id: 'xss', title: 'تدقيق XSS', cmd: process.execPath, args: ['tools/xss-audit.js'] },
  { id: 'test', title: 'اختبارات الوحدة والتكامل', cmd: npmCmd, args: ['run', '--silent', 'test'] },
];

function run(check) {
  const started = Date.now();
  const res = spawnSync(check.cmd, check.args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'test',
      CI: 'true',
      FORCE_COLOR: '0',
    },
  });
  const output = `${res.stdout || ''}${res.stderr || ''}`.trim();
  return {
    ...check,
    ok: res.status === 0,
    code: res.status === null ? 1 : res.status,
    durationMs: Date.now() - started,
    output,
  };
}

function parseTestCounts(output) {
  const pick = (label) => {
    const m = output.match(new RegExp(`^#\\s*${label}\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return { tests: pick('tests'), pass: pick('pass'), fail: pick('fail'), skipped: pick('skipped') };
}

function tail(text, lines = 40) {
  const parts = text.split('\n');
  return parts.length <= lines ? text : parts.slice(-lines).join('\n');
}

const results = CHECKS.map(run);
const failed = results.filter((r) => !r.ok);
const counts = parseTestCounts(results.find((r) => r.id === 'test')?.output || '');

const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

const rows = results
  .map(
    (r) =>
      `| ${r.title} | ${r.ok ? '✅ ناجح' : '❌ فاشل'} | ${(r.durationMs / 1000).toFixed(1)}s |`,
  )
  .join('\n');

let md = `<!-- ci-report -->
# تقرير الجودة التلقائي

- **المشروع:** ${pkg.name} v${pkg.version}
- **التاريخ:** ${now}
- **Node:** ${process.version}
${process.env.GITHUB_SHA ? `- **Commit:** \`${process.env.GITHUB_SHA.slice(0, 7)}\`\n` : ''}${process.env.GITHUB_REF_NAME ? `- **الفرع/الـ PR:** ${process.env.GITHUB_REF_NAME}\n` : ''}
## النتيجة العامة: ${failed.length === 0 ? '✅ كل الفحوصات ناجحة' : `❌ ${failed.length} فحص فاشل`}

| الفحص | الحالة | المدة |
| --- | --- | --- |
${rows}
`;

if (counts.tests !== null) {
  md += `
## الاختبارات

- إجمالي: **${counts.tests}**
- ناجح: **${counts.pass ?? 0}**
- فاشل: **${counts.fail ?? 0}**
- متخطّى: **${counts.skipped ?? 0}**
`;
}

if (failed.length) {
  md += `
## تفاصيل الفشل
`;
  for (const f of failed) {
    md += `
<details><summary>${f.title} (exit ${f.code})</summary>

\`\`\`
${tail(f.output).replace(/```/g, '` ``')}
\`\`\`

</details>
`;
  }
}

fs.writeFileSync(outFile, md, 'utf8');
process.stdout.write(md + `\n\nتم حفظ التقرير في: ${path.relative(process.cwd(), outFile)}\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md, 'utf8');
}

process.exit(failed.length ? 1 : 0);
