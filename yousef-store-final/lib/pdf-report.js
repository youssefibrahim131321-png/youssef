/**
 * lib/pdf-report.js — مولّد PDF بسيط بدون أي مكتبة خارجية.
 * ---------------------------------------------------------------------------
 * ليه من غير مكتبة؟ السيرفر بيشتغل على منصة مُدارة والاعتماديات أقل = مساحة
 * هجوم وحجم نشر أقل. الاحتياج هنا محدود: جدول تقرير أبيض وأسود بخط قياسي.
 *
 * قيد مهم: خطوط PDF المدمجة (Helvetica) بترميز WinAnsi، وده مش بيدعم الحروف
 * العربية. فالتقرير بالإنجليزية عن قصد (نفس البيانات بالعربي متاحة في نسخة
 * CSV). أي حرف غير مدعوم بيتحوّل لـ '?' بدل ما يطلع مربعات سودة.
 */

const PAGE = { width: 842, height: 595, margin: 36 }; // A4 أفقي (landscape) — أعمدة أكتر

function toWinAnsi(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    // أي حرف برّه ASCII القابل للطباعة (بما فيه العربي) مش مدعوم في Helvetica.
    .replace(/[^\x20-\x7E]/g, '?');
}

function escapePdfText(text) {
  return toWinAnsi(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** تقدير عرض النص (تقريبي) عشان القص عند حدود العمود. */
function fitText(text, maxWidth, fontSize) {
  const approxCharWidth = fontSize * 0.5;
  const maxChars = Math.max(1, Math.floor(maxWidth / approxCharWidth));
  const clean = toWinAnsi(text);
  return clean.length > maxChars ? `${clean.slice(0, Math.max(1, maxChars - 1))}.` : clean;
}

class PageBuilder {
  constructor() { this.ops = []; }
  text(x, y, value, { size = 9, bold = false } = {}) {
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfText(value)}) Tj ET`);
  }
  line(x1, y1, x2, y2, { width = 0.6, gray = 0.75 } = {}) {
    this.ops.push(`q ${gray} G ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S Q`);
  }
  band(x, y, w, h, gray = 0.93) {
    this.ops.push(`q ${gray} g ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f Q`);
  }
  toStream() { return this.ops.join('\n'); }
}

/**
 * بيبني PDF من تعريف تقرير:
 *   { title, subtitle, meta: [[label, value]], columns: [{ header, key, width, align }], rows, footer }
 * بيرجّع Buffer جاهز للإرسال.
 */
function buildTablePdf({ title, subtitle = '', meta = [], columns = [], rows = [], footer = '' }) {
  const usableWidth = PAGE.width - PAGE.margin * 2;
  const declared = columns.reduce((sum, c) => sum + (Number(c.width) || 1), 0) || 1;
  const widths = columns.map((c) => ((Number(c.width) || 1) / declared) * usableWidth);
  const rowHeight = 15;
  const pages = [];

  let page = new PageBuilder();
  let y = 0;

  const startPage = (pageIndex) => {
    page = new PageBuilder();
    y = PAGE.height - PAGE.margin;
    page.text(PAGE.margin, y, title, { size: 15, bold: true });
    y -= 17;
    if (subtitle) { page.text(PAGE.margin, y, subtitle, { size: 9.5 }); y -= 13; }
    if (pageIndex === 0 && meta.length) {
      for (const [label, value] of meta) {
        page.text(PAGE.margin, y, `${label}: ${value}`, { size: 9 });
        y -= 12;
      }
    }
    y -= 6;
    // رأس الجدول
    page.band(PAGE.margin, y - 4, usableWidth, rowHeight);
    let x = PAGE.margin;
    columns.forEach((col, i) => {
      page.text(x + 3, y, fitText(col.header, widths[i] - 6, 9), { size: 9, bold: true });
      x += widths[i];
    });
    y -= rowHeight;
    page.line(PAGE.margin, y + 4, PAGE.margin + usableWidth, y + 4);
  };

  startPage(0);
  if (!rows.length) {
    page.text(PAGE.margin, y - 6, 'No discrepancies found for the selected period.', { size: 10 });
    y -= 20;
  }
  rows.forEach((row, index) => {
    if (y < PAGE.margin + 40) {
      pages.push(page);
      startPage(pages.length);
    }
    if (index % 2 === 1) page.band(PAGE.margin, y - 4, usableWidth, rowHeight, 0.97);
    let x = PAGE.margin;
    columns.forEach((col, i) => {
      const raw = row[col.key];
      const value = raw === null || raw === undefined ? '' : String(raw);
      const text = fitText(value, widths[i] - 6, 8.5);
      const approx = text.length * 8.5 * 0.5;
      const tx = col.align === 'right' ? x + widths[i] - 3 - approx : x + 3;
      page.text(tx, y, text, { size: 8.5 });
      x += widths[i];
    });
    y -= rowHeight;
  });
  if (footer) {
    page.line(PAGE.margin, PAGE.margin + 16, PAGE.margin + usableWidth, PAGE.margin + 16);
    page.text(PAGE.margin, PAGE.margin + 4, footer, { size: 8 });
  }
  pages.push(page);

  return assemblePdf(pages.map((p) => p.toStream()));
}

function assemblePdf(streams) {
  const objects = [];
  const pageCount = streams.length;
  // 1: Catalog، 2: Pages، 3: F1، 4: F2، بعدين لكل صفحة (Page + Contents)
  const firstPageObj = 5;
  const pageIds = streams.map((_, i) => firstPageObj + i * 2);

  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  streams.forEach((stream, i) => {
    const contentsId = pageIds[i] + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentsId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = { buildTablePdf };
