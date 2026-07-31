import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import PizZip from 'pizzip';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { canonicalJson } from './quotation-drafts.mjs';
import { publishImmutableBuffer } from './quotation-renderer.mjs';
import { buildFinanceReport } from './finance-reports.mjs';
import { repositoryRoot } from '../validate-config.mjs';

const FIXED_ZIP_DATE = new Date('2000-01-01T00:00:00.000Z');

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}
function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
function csv(value) {
  if (value == null) return '';
  let text = typeof value === 'object' ? canonicalJson(value) : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function columns(rows) {
  const result = [];
  const seen = new Set();
  for (const row of rows) for (const key of Object.keys(row)) if (!seen.has(key)) { seen.add(key); result.push(key); }
  return result;
}
function displayWidth(value) {
  if (value == null) return 0;
  const text = typeof value === 'object' ? canonicalJson(value) : String(value);
  return Math.min(42, Math.max(0, text.length + 2));
}
function exportRows(report, classification) {
  const metadata = {
    classification, report_type: report.reportType, period_start: report.period.start,
    period_end_exclusive: report.period.endExclusive, generated_at: report.generatedAt,
    currency_policy: report.currencyPolicy
  };
  return report.rows.length ? report.rows.map((row) => ({ ...metadata, ...row })) : [metadata];
}
function csvBuffer(report, classification) {
  const rows = exportRows(report, classification);
  const headers = columns(rows);
  return Buffer.from(`${headers.map(csv).join(',')}\r\n${rows.map((row) => headers.map((key) => csv(row[key])).join(',')).join('\r\n')}\r\n`);
}
function colName(index) {
  let value = index + 1;
  let result = '';
  while (value) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}
function excelDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return (Date.parse(`${value}T00:00:00.000Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
}
function cell(reference, value, { style = 0, formula = null, cached = null } = {}) {
  if (formula) {
    const type = typeof cached === 'string' ? ' t="str"' : '';
    return `<c r="${reference}" s="${style}"${type}><f>${xml(formula)}</f><v>${xml(cached ?? 0)}</v></c>`;
  }
  if (value == null) return `<c r="${reference}" s="${style}"/>`;
  if (typeof value === 'number') return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${reference}" s="${style}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const date = excelDate(value);
  if (date != null) return `<c r="${reference}" s="3"><v>${date}</v></c>`;
  const text = typeof value === 'object' ? canonicalJson(value) : String(value);
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}
function worksheet(rows, widths = []) {
  const maxColumns = Math.max(1, ...rows.map((row) => row.length));
  const maxRows = Math.max(1, rows.length);
  const columnXml = widths.length ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>` : '';
  const body = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((item, columnIndex) =>
    cell(`${colName(columnIndex)}${rowIndex + 1}`, item.value, item)
  ).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${colName(maxColumns - 1)}${maxRows}"/>${columnXml}
<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/><sheetData>${body}</sheetData><autoFilter ref="A1:${colName(maxColumns - 1)}${maxRows}"/>
</worksheet>`;
}
function xlsxBuffer(report, classification) {
  const data = exportRows(report, classification);
  const headers = columns(data);
  const currencyColumn = headers.indexOf('currency');
  const amountKey = headers.includes('recognized_minor') ? 'recognized_minor' : headers.includes('invoice_total_minor') ? 'invoice_total_minor' : null;
  const amountColumn = amountKey ? headers.indexOf(amountKey) : -1;
  const dataRows = [
    headers.map((value) => ({ value, style: 2 })),
    ...data.map((row) => headers.map((key) => ({
      value: row[key],
      style: /_minor$/.test(key) ? 4 : /_date$|^date$/.test(key) ? 3 : 0
    })))
  ];
  const dataWidths = headers.map((header) => {
    const widest = Math.max(displayWidth(header), ...data.map((row) => displayWidth(row[header])));
    if (/_minor$/.test(header)) return Math.max(18, Math.min(24, widest));
    if (/_date$|^date$/.test(header)) return 14;
    return Math.max(12, Math.min(42, widest));
  });
  const summaryRows = [
    [{ value: 'Mira Finance Report', style: 1 }],
    [{ value: 'Classification', style: 5 }, { value: classification }],
    [{ value: 'Report', style: 5 }, { value: report.reportType }],
    [{ value: 'Period', style: 5 }, { value: `${report.period.start ?? 'all'} to ${report.period.endExclusive ?? 'all'} (exclusive)` }],
    [{ value: 'Currency', style: 2 }, { value: 'Recognized total (minor units)', style: 2 }, { value: 'Row count', style: 2 }]
  ];
  for (const [index, item] of report.currencyTotals.entries()) {
    const rowNumber = index + 6;
    const endRow = Math.max(2, dataRows.length);
    const currencyRange = currencyColumn >= 0 ? `'Data'!$${colName(currencyColumn)}$2:$${colName(currencyColumn)}$${endRow}` : null;
    const amountRange = amountColumn >= 0 ? `'Data'!$${colName(amountColumn)}$2:$${colName(amountColumn)}$${endRow}` : null;
    summaryRows.push([
      { value: item.currency },
      currencyRange && amountRange
        ? { formula: `SUMIF(${currencyRange},A${rowNumber},${amountRange})`, cached: item.totalMinor, style: 4 }
        : { value: item.totalMinor, style: 4 },
      currencyRange
        ? { formula: `COUNTIF(${currencyRange},A${rowNumber})`, cached: report.rows.filter((row) => row.currency === item.currency).length, style: 4 }
        : { value: 0, style: 4 }
    ]);
  }
  const checks = [
    [{ value: 'F14 Export Checks', style: 1 }],
    [{ value: 'Check', style: 2 }, { value: 'Actual', style: 2 }, { value: 'Expected', style: 2 }, { value: 'Status', style: 2 }, { value: 'Notes', style: 2 }],
    [
      { value: 'Data row count' },
      { formula: `COUNTA('Data'!$A$2:$A$${Math.max(2, dataRows.length)})`, cached: report.rows.length || 1, style: 4 },
      { value: report.rows.length || 1, style: 4 },
      { formula: 'IF(B3=C3,"OK","FAIL")', cached: 'OK', style: 6 },
      { value: 'Empty reports contain one metadata row.' }
    ],
    [{ value: 'Currency policy' }, { value: report.currencyPolicy }, { value: 'NO_CONVERSION' }, { formula: 'IF(B4=C4,"OK","FAIL")', cached: 'OK', style: 6 }, { value: 'Currencies are never summed together.' }]
  ];
  const zip = new PizZip();
  const add = (name, content) => zip.file(name, content, { date: FIXED_ZIP_DATE });
  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Data" sheetId="2" r:id="rId2"/><sheet name="Checks" sheetId="3" r:id="rId3"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`);
  add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  add('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="#,##0;[Red](#,##0);-"/></numFmts><fonts count="4"><font><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="16"/><name val="Aptos Display"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font><font><b/><color rgb="FF166534"/><sz val="10"/><name val="Aptos"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17365D"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/></patternFill></fill></fills><borders count="2"><border/><border><bottom style="thin"><color rgb="FF9CA3AF"/></bottom></border></borders><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyFont="1"/></cellXfs></styleSheet>`);
  add('xl/worksheets/sheet1.xml', worksheet(summaryRows, [26, 34, 14]));
  add('xl/worksheets/sheet2.xml', worksheet(dataRows, dataWidths));
  add('xl/worksheets/sheet3.xml', worksheet(checks, [24, 20, 20, 12, 42]));
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

export async function exportFinanceReport({
  databasePath, reportType, filters = {}, format, actor, generatedAt = new Date().toISOString(),
  testMode = false, root = repositoryRoot, outputRoot = path.join(root, 'generated', 'reports')
}) {
  required(actor, 'actor');
  const normalizedFormat = required(format, 'format').toUpperCase();
  if (!['CSV', 'XLSX'].includes(normalizedFormat)) throw new TypeError('format must be CSV or XLSX.');
  const report = buildFinanceReport({ databasePath, reportType, filters, generatedAt });
  const classification = testMode ? 'TEST / NOT VALID' : 'OPERATIONAL';
  const buffer = normalizedFormat === 'CSV' ? csvBuffer(report, classification) : xlsxBuffer(report, classification);
  const hash = createHash('sha256').update(buffer).digest('hex');
  const extension = normalizedFormat.toLowerCase();
  const period = report.period.label.replaceAll(/[^0-9A-Za-z_-]/g, '-');
  const relativePath = path.join(generatedAt.slice(0, 4), generatedAt.slice(5, 7), `${reportType}-${period}-${hash.slice(0, 12)}.${extension}`);
  const filePath = path.join(outputRoot, relativePath);
  await publishImmutableBuffer(filePath, buffer);
  try {
    const database = openDatabase(databasePath);
    try {
      withImmediateTransaction(database, () => {
        database.prepare(`INSERT INTO report_exports
          (report_type,format,period_start,period_end_exclusive,currency,customer_id,classification,relative_path,
           sha256,size_bytes,row_count,currency_totals_json,generated_by,generated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          reportType, normalizedFormat, report.period.start, report.period.endExclusive, report.filters.currency,
          report.filters.customerId, classification, relativePath.split(path.sep).join('/'), hash, buffer.length,
          report.rows.length, canonicalJson(report.currencyTotals), actor, generatedAt
        );
        database.prepare(`INSERT INTO audit_events
          (timestamp,actor,action,entity_type,after_hash,result,details_json)
          VALUES (?,?,'report.exported','report',?,'PASS',?)`).run(
          generatedAt, actor, hash, canonicalJson({ reportType, format: normalizedFormat, rowCount: report.rows.length, classification })
        );
      });
    } finally { database.close(); }
  } catch (error) {
    await rm(filePath, { force: true });
    throw error;
  }
  return { report, classification, format: normalizedFormat, hash, relativePath: relativePath.split(path.sep).join('/'), filePath, size: buffer.length };
}
