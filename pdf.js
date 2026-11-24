'use strict';
// Tiny dependency-free PDF writer, used for placeholder downloads of seeded
// materials that have no uploaded file yet.

function esc(s) {
  return String(s).replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7E]/g, '?');
}

function wrap(text, width = 85) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

function makePdf(title, paragraphs = []) {
  let content = `BT /F1 20 Tf 50 790 Td (${esc(title).slice(0, 70)}) Tj ET\n`;
  let y = 750;
  outer: for (const p of paragraphs) {
    for (const line of wrap(p)) {
      if (y < 50) break outer;
      content += `BT /F1 11 Tf 50 ${y} Td (${esc(line)}) Tj ET\n`;
      y -= 17;
    }
    y -= 8;
  }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

module.exports = { makePdf };
