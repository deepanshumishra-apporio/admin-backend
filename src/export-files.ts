// Excel (.xlsx) and PDF files for report downloads, written by hand: this server has no dependencies, and a table
// needs only a sliver of either format. Excel: one sheet, a bold header row, numbers as numbers. PDF: a landscape A4
// table in Helvetica with a title, notes, repeated headers and page numbers.
import { crc32, deflateRawSync } from 'node:zlib';

export type ExportColumn = { label: string; kind: 'text' | 'percent' | 'count'; width: number };
export type ExportCell = string | number | null;

// --- xlsx ------------------------------------------------------------------------------------------------------

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 forbids most control characters.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** A1-style column letters: 0 -> A, 26 -> AA. */
const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

/** A zip archive of the given files, deflated (what an .xlsx is). */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(0, 12); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** An .xlsx with one sheet: notes above the table, a bold header, then the rows. Percent columns are numbers to 2 places. */
export function xlsx(sheet: string, notes: string[], columns: ExportColumn[], rows: ExportCell[][]): Buffer {
  const cell = (ref: string, v: ExportCell, style: number) => {
    if (v === null || v === '') return `<c r="${ref}" s="${style}"/>`;
    if (typeof v === 'number') return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
  };
  const lines: string[] = [];
  let r = 1;
  for (const n of notes) lines.push(`<row r="${r}">${cell(`A${r++}`, n, n === notes[0] ? 2 : 0)}</row>`);
  if (notes.length) r++;
  const header = r;
  lines.push(`<row r="${r}">${columns.map((c, i) => cell(`${colName(i)}${r}`, c.label, 1)).join('')}</row>`);
  r++;
  for (const row of rows) {
    lines.push(`<row r="${r}">${row.map((v, i) => cell(`${colName(i)}${r}`, v, columns[i]?.kind === 'percent' ? 3 : 0)).join('')}</row>`);
    r++;
  }
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${header}" topLeftCell="A${header + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('')}</cols>
<sheetData>${lines.join('')}</sheetData>
<autoFilter ref="A${header}:${colName(columns.length - 1)}${Math.max(header, r - 1)}"/>
</worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF5"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;
  const name = xml(sheet.slice(0, 31).replace(/[[\]:*?/\\]/g, ' '));
  const b = (s: string) => Buffer.from(s, 'utf8');
  return zip([
    { name: '[Content_Types].xml', data: b(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`) },
    { name: '_rels/.rels', data: b(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: b(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name}'!$A$${header}:$${colName(columns.length - 1)}$${Math.max(header, r - 1)}</definedName></definedNames></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: b(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/worksheets/sheet1.xml', data: b(sheetXml) },
    { name: 'xl/styles.xml', data: b(styles) },
  ]);
}

// --- pdf -------------------------------------------------------------------------------------------------------

// Helvetica widths (1/1000 em) for what a report prints; anything else counts as 556.
const Narrow = new Map<string, number>([...' ,.:;!|il\'I'].map((ch) => [ch, 278]));
const widthOf: (ch: string) => number = (ch) =>
  Narrow.get(ch) ?? (ch === '-' || ch === '(' || ch === ')' || ch === 'r' || ch === 'f' || ch === 't' || ch === 'j' ? 333
    : ch === '%' ? 889 : ch === 'm' || ch === 'M' || ch === 'W' ? 833 : ch === 'w' ? 722 : /[A-Z]/.test(ch) ? 667 : ch === '+' ? 584 : 556);
const textWidth = (s: string, size: number, bold = false) => [...s].reduce((w, ch) => w + widthOf(ch), 0) * size / 1000 * (bold ? 1.05 : 1);

/** PDF's base fonts speak WinAnsi: typographic quotes and dashes to ASCII, ₹ to Rs, the rest dropped. */
const ansi = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/₹/g, 'Rs ')
  .replace(/…/g, '...').replace(/[^\x20-\x7E]/g, '');
const pdfText = (s: string) => ansi(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function fit(s: string, width: number, size: number, bold = false): string {
  const t = ansi(s);
  if (textWidth(t, size, bold) <= width) return t;
  let out = t;
  while (out.length > 1 && textWidth(`${out}...`, size, bold) > width) out = out.slice(0, -1);
  return `${out.trimEnd()}...`;
}

/** Wraps a note to lines that fit `width`. */
function wrap(s: string, width: number, size: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of ansi(s).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** A landscape A4 PDF: title, notes, then the table, its header repeated on every page, page numbers at the foot. */
export function pdf(title: string, notes: string[], columns: ExportColumn[], rows: ExportCell[][]): Buffer {
  const W = 842, H = 595, M = 36;
  const total = columns.reduce((s, c) => s + c.width, 0);
  const widths = columns.map((c) => (c.width / total) * (W - 2 * M));
  const lineH = 15;
  const pages: string[] = [];
  let ops: string[] = [];
  let y = 0;
  const text = (x: number, yy: number, s: string, size: number, bold = false, color = '0.1 0.13 0.18') =>
    ops.push(`BT ${color} rg /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(1)} ${yy.toFixed(1)} Td (${pdfText(s)}) Tj ET`);
  const cellText = (i: number, x: number, yy: number, v: ExportCell, bold: boolean) => {
    const c = columns[i]!;
    // Headers a size smaller, so '3 months' fits a return column.
    const size = bold ? 7.5 : 8.5;
    const s = v === null || v === '' ? '-' : c.kind === 'percent' && typeof v === 'number' ? `${v > 0 ? '+' : ''}${v.toFixed(2)}%` : String(v);
    const shown = fit(s, widths[i]! - 6, size, bold);
    const right = c.kind !== 'text';
    const color = !bold && c.kind === 'percent' && typeof v === 'number' ? (v < 0 ? '0.75 0.15 0.15' : '0.05 0.5 0.25') : '0.1 0.13 0.18';
    text(right ? x + widths[i]! - 3 - textWidth(shown, size, bold) : x + 3, yy, shown, size, bold, color);
  };
  const header = () => {
    ops.push(`0.91 0.93 0.96 rg ${M} ${(y - 5).toFixed(1)} ${W - 2 * M} ${lineH + 2} re f`);
    let x = M;
    columns.forEach((c, i) => {
      cellText(i, x, y, c.label, true);
      x += widths[i]!;
    });
    y -= lineH + 4;
  };
  const newPage = (first: boolean) => {
    if (ops.length) pages.push(ops.join('\n'));
    ops = [];
    y = H - M - 4;
    if (first) {
      text(M, y, title, 15, true);
      y -= 20;
      for (const n of notes) for (const l of wrap(n, W - 2 * M, 8.5)) {
        text(M, y, l, 8.5, false, '0.4 0.45 0.52');
        y -= 12;
      }
      y -= 8;
    }
    header();
  };
  newPage(true);
  rows.forEach((row, ri) => {
    if (y < M + 24) newPage(false);
    if (ri % 2 === 1) ops.push(`0.97 0.98 0.99 rg ${M} ${(y - 4).toFixed(1)} ${W - 2 * M} ${lineH} re f`);
    let x = M;
    row.forEach((v, i) => {
      cellText(i, x, y, v, false);
      x += widths[i]!;
    });
    y -= lineH;
  });
  if (!rows.length) text(M + 4, y, 'No funds match these filters.', 9, false, '0.4 0.45 0.52');
  pages.push(ops.join('\n'));

  // Objects: 1 catalog, 2 pages, 3-4 fonts, then a page and its content per page.
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((content, i) => {
    const foot = `BT 0.4 0.45 0.52 rg /F1 8 Tf ${W - M - 60} ${M - 16} Td (Page ${i + 1} of ${pages.length}) Tj ET`;
    const stream = `${content}\n${foot}`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
