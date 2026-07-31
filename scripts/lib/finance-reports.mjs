import { openDatabase } from './database.mjs';

export const REPORT_TYPES = Object.freeze([
  'monthly-summary', 'annual-summary', 'quotation-register', 'invoice-register',
  'outstanding', 'overdue', 'claim-register', 'expense-by-category'
]);
const CURRENCIES = ['MYR', 'SGD', 'USD'];
const STATUS = Object.freeze({
  'quotation-register': ['DRAFT', 'PENDING_CONFIRMATION', 'GENERATING', 'ISSUED', 'ISSUE_FAILED', 'CANCELLED'],
  'invoice-register': ['DRAFT', 'PENDING_CONFIRMATION', 'GENERATING', 'ISSUED', 'ISSUE_FAILED', 'CANCELLED'],
  'claim-register': ['DRAFT', 'PENDING_CONFIRMATION', 'FILED', 'FILING_FAILED', 'CANCELLED']
});

function realDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${name} must use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new TypeError(`${name} must be a real calendar date.`);
  return value;
}
function monthRange(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) throw new TypeError('month must use YYYY-MM.');
  const start = realDate(`${month}-01`, 'month');
  const next = new Date(`${start}T00:00:00.000Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { start, endExclusive: next.toISOString().slice(0, 10), label: month };
}
function yearRange(year) {
  const value = Number(year);
  if (!Number.isSafeInteger(value) || value < 2000 || value > 9999) throw new TypeError('year must be 2000-9999.');
  return { start: `${value}-01-01`, endExclusive: `${value + 1}-01-01`, label: String(value) };
}
function explicitRange({ startDate, endDateExclusive }) {
  const start = realDate(startDate, 'start_date');
  const endExclusive = realDate(endDateExclusive, 'end_date_exclusive');
  if (endExclusive <= start) throw new RangeError('end_date_exclusive must be after start_date.');
  return { start, endExclusive, label: `${start}_${endExclusive}` };
}
function rangeFor(type, filters) {
  if (type === 'monthly-summary') return monthRange(filters.month);
  if (type === 'annual-summary') return yearRange(filters.year);
  if (filters.startDate || filters.endDateExclusive) return explicitRange(filters);
  return { start: null, endExclusive: null, label: 'all' };
}
function currency(value) {
  if (value == null || value === '') return null;
  const result = String(value).toUpperCase();
  if (!CURRENCIES.includes(result)) throw new TypeError('currency must be MYR, SGD, or USD.');
  return result;
}
function positiveId(value, name) {
  if (value == null || value === '') return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer.`);
  return result;
}
function status(type, value) {
  if (value == null || value === '') return null;
  if (!STATUS[type]?.includes(value)) throw new TypeError(`Unsupported ${type} status.`);
  return value;
}
function conditions({ dateColumn, range, currencyValue, customerId, statusValue, includeCancelled, customerColumn = 'customer_id', statusColumn = 'status' }) {
  const clauses = [];
  const params = [];
  if (range.start) { clauses.push(`${dateColumn}>=?`, `${dateColumn}<?`); params.push(range.start, range.endExclusive); }
  if (currencyValue) { clauses.push('currency=?'); params.push(currencyValue); }
  if (customerId) { clauses.push(`${customerColumn}=?`); params.push(customerId); }
  if (statusValue) { clauses.push(`${statusColumn}=?`); params.push(statusValue); }
  else if (!includeCancelled) clauses.push(`${statusColumn}<>'CANCELLED'`);
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
function totals(rows, amountField = 'recognized_minor') {
  return CURRENCIES.map((code) => ({
    currency: code,
    totalMinor: rows.filter((row) => row.currency === code).reduce((sum, row) => sum + Number(row[amountField] ?? 0), 0)
  }));
}
function summaryRows(database, range, currencyValue) {
  const currencyClause = currencyValue ? ' AND currency=?' : '';
  const params = currencyValue ? [range.start, range.endExclusive, currencyValue] : [range.start, range.endExclusive];
  const quotations = database.prepare(`SELECT currency,COUNT(*) AS count,COALESCE(SUM(total_minor),0) AS total_minor
    FROM quotations WHERE issue_date>=? AND issue_date<? AND status='ISSUED'${currencyClause} GROUP BY currency`).all(...params);
  const invoices = database.prepare(`SELECT currency,COUNT(*) AS count,COALESCE(SUM(total_minor),0) AS total_minor,
    COALESCE(SUM(amount_paid_minor),0) AS paid_minor,COALESCE(SUM(balance_due_minor),0) AS outstanding_minor
    FROM invoices WHERE issue_date>=? AND issue_date<? AND status='ISSUED'${currencyClause} GROUP BY currency`).all(...params);
  const claims = database.prepare(`SELECT currency,COUNT(*) AS count,COALESCE(SUM(total_minor),0) AS total_minor
    FROM claims WHERE transaction_date>=? AND transaction_date<? AND status='FILED'${currencyClause} GROUP BY currency`).all(...params);
  const supplierInvoices = database.prepare(`SELECT currency,COUNT(*) AS count,COALESCE(SUM(total_minor),0) AS total_minor
    FROM supplier_invoices WHERE issue_date>=? AND issue_date<? AND status='FILED'${currencyClause} GROUP BY currency`).all(...params);
  return CURRENCIES.filter((code) => !currencyValue || code === currencyValue).map((code) => {
    const q = quotations.find((row) => row.currency === code) ?? {};
    const i = invoices.find((row) => row.currency === code) ?? {};
    const c = claims.find((row) => row.currency === code) ?? {};
    const s = supplierInvoices.find((row) => row.currency === code) ?? {};
    return {
      currency: code,
      quotation_count: Number(q.count ?? 0), quotation_total_minor: Number(q.total_minor ?? 0),
      invoice_count: Number(i.count ?? 0), invoice_total_minor: Number(i.total_minor ?? 0),
      paid_minor: Number(i.paid_minor ?? 0), outstanding_minor: Number(i.outstanding_minor ?? 0),
      claim_count: Number(c.count ?? 0), claim_total_minor: Number(c.total_minor ?? 0),
      supplier_invoice_count: Number(s.count ?? 0), supplier_invoice_total_minor: Number(s.total_minor ?? 0)
    };
  });
}

export function buildFinanceReport({
  databasePath, reportType, filters = {}, generatedAt = new Date().toISOString()
}) {
  if (!REPORT_TYPES.includes(reportType)) throw new TypeError('Unsupported report type.');
  if (new Date(generatedAt).toISOString() !== generatedAt) throw new TypeError('generatedAt must be an ISO-8601 UTC instant.');
  const range = rangeFor(reportType, filters);
  const currencyValue = currency(filters.currency);
  const customerId = positiveId(filters.customerId, 'customer_id');
  const includeCancelled = filters.includeCancelled === true;
  const statusValue = status(reportType, filters.status);
  const asOfDate = filters.asOfDate ? realDate(filters.asOfDate, 'as_of_date') : generatedAt.slice(0, 10);
  const database = openDatabase(databasePath, { readOnly: true });
  let rows;
  let amountField = 'recognized_minor';
  try {
    if (['monthly-summary', 'annual-summary'].includes(reportType)) {
      if (customerId) throw new Error('Customer filtering is not available for aggregate summaries; use a register.');
      rows = summaryRows(database, range, currencyValue);
      amountField = 'invoice_total_minor';
    } else if (reportType === 'quotation-register') {
      const where = conditions({ dateColumn: 'q.issue_date', range, currencyValue, customerId, statusValue, includeCancelled, customerColumn: 'q.customer_id', statusColumn: 'q.status' });
      rows = database.prepare(`SELECT q.id,q.quotation_number,q.status,q.issue_date,q.valid_until,q.customer_id,c.customer_code,c.display_name AS customer_name,
        q.currency,q.total_minor,CASE WHEN q.status='ISSUED' THEN q.total_minor ELSE 0 END AS recognized_minor,
        CASE WHEN q.status='ISSUE_FAILED' THEN 1 ELSE 0 END AS failed_issuance
        FROM quotations q LEFT JOIN customers c ON c.id=q.customer_id ${where.sql} ORDER BY q.issue_date,q.id`).all(...where.params);
    } else if (reportType === 'invoice-register') {
      const where = conditions({ dateColumn: 'i.issue_date', range, currencyValue, customerId, statusValue, includeCancelled, customerColumn: 'i.customer_id', statusColumn: 'i.status' });
      rows = database.prepare(`SELECT i.id,i.invoice_number,i.status,i.issue_date,i.due_date,i.customer_id,c.customer_code,c.display_name AS customer_name,
        i.currency,i.total_minor,i.amount_paid_minor,i.balance_due_minor,i.payment_status,
        CASE WHEN i.status='ISSUED' THEN i.total_minor ELSE 0 END AS recognized_minor,
        CASE WHEN i.status='ISSUE_FAILED' THEN 1 ELSE 0 END AS failed_issuance
        FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id ${where.sql} ORDER BY i.issue_date,i.id`).all(...where.params);
    } else if (reportType === 'outstanding' || reportType === 'overdue') {
      const clauses = ["i.status='ISSUED'", 'i.balance_due_minor>0'];
      const params = [];
      if (range.start) { clauses.push('i.issue_date>=?', 'i.issue_date<?'); params.push(range.start, range.endExclusive); }
      if (currencyValue) { clauses.push('i.currency=?'); params.push(currencyValue); }
      if (customerId) { clauses.push('i.customer_id=?'); params.push(customerId); }
      if (reportType === 'overdue') { clauses.push('i.due_date<?'); params.push(asOfDate); }
      rows = database.prepare(`SELECT i.id,i.invoice_number,i.issue_date,i.due_date,i.customer_id,c.customer_code,c.display_name AS customer_name,
        i.currency,i.total_minor,i.amount_paid_minor,i.balance_due_minor AS recognized_minor,i.payment_status,
        CAST(julianday(?) - julianday(i.due_date) AS INTEGER) AS days_overdue
        FROM invoices i LEFT JOIN customers c ON c.id=i.customer_id WHERE ${clauses.join(' AND ')}
        ORDER BY i.due_date,i.id`).all(asOfDate, ...params);
    } else if (reportType === 'claim-register') {
      const where = conditions({ dateColumn: 'cl.transaction_date', range, currencyValue, customerId, statusValue, includeCancelled, customerColumn: 'r.customer_id', statusColumn: 'cl.status' });
      rows = database.prepare(`SELECT cl.id,cl.claim_number,cl.status,cl.transaction_date,cl.merchant,cl.description,cl.category,
        cl.client_or_project,cl.currency,cl.total_minor,CASE WHEN cl.status='FILED' THEN cl.total_minor ELSE 0 END AS recognized_minor,
        r.customer_id,cu.customer_code,cu.display_name AS customer_name,r.project_reference,r.status AS recharge_status
        FROM claims cl LEFT JOIN claim_recharges r ON r.claim_id=cl.id LEFT JOIN customers cu ON cu.id=r.customer_id
        ${where.sql} ORDER BY cl.transaction_date,cl.id`).all(...where.params);
    } else {
      const clauses = ["status='FILED'"];
      const params = [range.start, range.endExclusive];
      if (currencyValue) { clauses.push('currency=?'); params.push(currencyValue); }
      rows = database.prepare(`SELECT source_type,category,currency,COUNT(*) AS document_count,SUM(total_minor) AS recognized_minor FROM (
        SELECT 'CLAIM' AS source_type,COALESCE(category,'uncategorised') AS category,currency,total_minor,status,transaction_date AS activity_date
        FROM claims UNION ALL
        SELECT 'SUPPLIER_INVOICE',COALESCE(expense_category,'uncategorised'),currency,total_minor,status,issue_date
        FROM supplier_invoices
      ) WHERE activity_date>=? AND activity_date<? AND ${clauses.join(' AND ')}
      GROUP BY source_type,category,currency ORDER BY currency,category,source_type`).all(...params);
    }
  } finally { database.close(); }
  const currencyTotals = totals(rows, amountField);
  return {
    schemaVersion: 1, phase: 'F14', reportType, generatedAt,
    period: { start: range.start, endExclusive: range.endExclusive, label: range.label },
    filters: { currency: currencyValue, customerId, status: statusValue, includeCancelled, asOfDate },
    currencyPolicy: 'NO_CONVERSION', rows, currencyTotals,
    controls: {
      dateBoundary: '[start,end)', cancelledExcludedByDefault: true,
      failedIssuanceRecognizedMinor: 0, rowCount: rows.length,
      separateCurrencyTotals: true
    }
  };
}
