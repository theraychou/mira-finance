import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { canonicalJson } from './quotation-drafts.mjs';
import { publishImmutableBuffer } from './quotation-renderer.mjs';

const CURRENCIES = ['MYR', 'SGD', 'USD'];

function monthRange(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) throw new TypeError('month must use YYYY-MM format.');
  const start = `${month}-01`;
  const date = new Date(`${start}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 7) !== month) throw new TypeError('month must be a real calendar month.');
  date.setUTCMonth(date.getUTCMonth() + 1);
  return { start, end: date.toISOString().slice(0, 10) };
}

export async function generateMonthlyTestReport({
  databasePath,
  month,
  generatedAt,
  actor,
  outputRoot
}) {
  const range = monthRange(month);
  if (typeof generatedAt !== 'string' || new Date(generatedAt).toISOString() !== generatedAt) throw new TypeError('generatedAt must be an ISO-8601 UTC instant.');
  if (typeof actor !== 'string' || !actor.trim()) throw new TypeError('actor is required.');
  const database = openDatabase(databasePath, { readOnly: true });
  let report;
  try {
    const quotationRows = database.prepare(`
      SELECT currency, COUNT(*) AS document_count, COALESCE(SUM(total_minor), 0) AS total_minor
      FROM quotations WHERE issue_date >= ? AND issue_date < ? GROUP BY currency ORDER BY currency
    `).all(range.start, range.end);
    const invoiceRows = database.prepare(`
      SELECT currency, COUNT(*) AS document_count, COALESCE(SUM(total_minor), 0) AS total_minor,
        COALESCE(SUM(amount_paid_minor), 0) AS amount_paid_minor,
        COALESCE(SUM(balance_due_minor), 0) AS balance_due_minor
      FROM invoices WHERE issue_date >= ? AND issue_date < ? GROUP BY currency ORDER BY currency
    `).all(range.start, range.end);
    const byCurrency = CURRENCIES.map((currency) => {
      const quotations = quotationRows.find((row) => row.currency === currency) ?? {};
      const invoices = invoiceRows.find((row) => row.currency === currency) ?? {};
      return {
        currency,
        quotations: {
          count: Number(quotations.document_count ?? 0),
          totalMinor: Number(quotations.total_minor ?? 0)
        },
        invoices: {
          count: Number(invoices.document_count ?? 0),
          totalMinor: Number(invoices.total_minor ?? 0),
          paidMinor: Number(invoices.amount_paid_minor ?? 0),
          balanceDueMinor: Number(invoices.balance_due_minor ?? 0)
        }
      };
    });
    report = {
      schemaVersion: 1,
      phase: 'F11',
      classification: 'TEST / NOT VALID',
      month,
      generatedAt,
      currencyPolicy: 'NO_CONVERSION',
      currencies: byCurrency,
      controls: {
        separateCurrencyTotals: true,
        taxMode: 'NONE',
        testDocumentsOnly: true
      }
    };
  } finally {
    database.close();
  }

  const buffer = Buffer.from(`${canonicalJson(report)}\n`);
  const reportHash = createHash('sha256').update(buffer).digest('hex');
  const relativePath = path.join(month.slice(0, 4), month.slice(5, 7), 'f11-monthly-report.test.json');
  const filePath = path.join(outputRoot, relativePath);
  await publishImmutableBuffer(filePath, buffer);
  try {
    const writable = openDatabase(databasePath);
    try {
      withImmediateTransaction(writable, () => {
        writable.prepare(`
          INSERT INTO audit_events
            (timestamp, actor, action, entity_type, after_hash, result, details_json)
          VALUES (?, ?, 'report.monthly_test_generated', 'report', ?, 'PASS', ?)
        `).run(generatedAt, actor, reportHash, canonicalJson({ month, classification: 'TEST / NOT VALID' }));
      });
    } finally {
      writable.close();
    }
  } catch (error) {
    await rm(filePath, { force: true });
    throw error;
  }
  return { report, reportHash, relativePath: relativePath.split(path.sep).join('/'), filePath };
}
