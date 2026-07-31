import { createHash } from 'node:crypto';

function clean(value) {
  return typeof value === 'string' ? value.replaceAll('\u0000', '').replace(/\r\n?/g, '\n').slice(0, 250_000) : '';
}
function isoDate(value) {
  const match = /\b(20\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b/.exec(value);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}
function labelledDate(text, labels) {
  for (const label of labels) {
    const line = new RegExp(`${label}\\s*[:\\-]?\\s*([^\\n]{0,40})`, 'i').exec(text);
    const date = line ? isoDate(line[1]) : null;
    if (date) return date;
  }
  return null;
}
function invoiceNumber(text) {
  return /(?:SUPPLIER\s+)?INVOICE\s*(?:NO|NUMBER|#)\s*[:\-]?\s*([A-Z0-9][A-Z0-9./_-]{0,119})/i.exec(text)?.[1] ?? null;
}
function parseCurrency(text) {
  const upper = text.toUpperCase();
  if (/\bMYR\b|RM\s*\d/.test(upper)) return 'MYR';
  if (/\bSGD\b|S\$\s*\d/.test(upper)) return 'SGD';
  if (/\bUSD\b|US\$\s*\d/.test(upper)) return 'USD';
  return null;
}
function amountAfter(text, label) {
  const matches = [...text.matchAll(new RegExp(`${label}\\s*[:\\-]?\\s*(?:MYR|SGD|USD|RM|S\\$|US\\$|\\$)?\\s*([0-9][0-9,]*)(?:\\.([0-9]{1,2}))?`, 'gi'))];
  const match = matches.at(-1);
  if (!match) return null;
  const value = Number(match[1].replaceAll(',', '')) * 100 + Number((match[2] ?? '').padEnd(2, '0') || 0);
  return Number.isSafeInteger(value) ? value : null;
}
function supplierName(text) {
  return text.split('\n').map((line) => line.trim()).find((line) =>
    line.length >= 2 && line.length <= 120 && !/TEST\s*\/\s*NOT VALID/i.test(line) &&
    !/^(?:INVOICE|TAX INVOICE|BILL TO|TOTAL|AMOUNT)/i.test(line)
  ) ?? null;
}

export function classifyIncomingSupplierInvoice({ declaredClassification, text = '' }) {
  if (declaredClassification !== 'SUPPLIER_INVOICE') throw new Error('INCOMING_SUPPLIER_INVOICE_CLASSIFICATION_REQUIRED');
  const safe = clean(text);
  const markers = /\b(?:supplier\s+invoice|tax\s+invoice|invoice\s+(?:no|number|#)|amount\s+due)\b/i.test(safe);
  return { classification: 'SUPPLIER_INVOICE', advisoryMarkersPresent: markers };
}

export function extractSupplierInvoiceFields({ text, advisoryFields = {}, categories = [] }) {
  const safe = clean(text);
  const totalMinor = advisoryFields.totalMinor ?? amountAfter(safe, '(?:GRAND\\s+TOTAL|AMOUNT\\s+DUE|TOTAL)');
  const taxMinor = advisoryFields.taxMinor ?? amountAfter(safe, '(?:TAX|GST|SST)') ?? 0;
  const subtotalMinor = advisoryFields.subtotalMinor ?? (totalMinor == null ? null : totalMinor - taxMinor);
  const normalized = safe.toLowerCase();
  const mapped = categories.find((category) => category.terms.some((term) => normalized.includes(term.toLowerCase())));
  return {
    supplierQuery: advisoryFields.supplierQuery ?? supplierName(safe),
    supplierInvoiceNumber: advisoryFields.supplierInvoiceNumber ?? invoiceNumber(safe),
    issueDate: advisoryFields.issueDate ?? labelledDate(safe, ['invoice\\s+date', 'issue\\s+date', 'date']),
    dueDate: advisoryFields.dueDate ?? labelledDate(safe, ['due\\s+date', 'payment\\s+due']),
    expenseCategory: advisoryFields.expenseCategory ?? mapped?.id ?? null,
    projectAllocation: advisoryFields.projectAllocation ?? null,
    currency: advisoryFields.currency ? String(advisoryFields.currency).toUpperCase() : parseCurrency(safe),
    subtotalMinor,
    taxMinor,
    totalMinor,
    description: advisoryFields.description ?? null,
    purchaseOrderReference: advisoryFields.purchaseOrderReference ?? null,
    textSha256: safe ? createHash('sha256').update(safe).digest('hex') : null
  };
}

export function probableSupplierInvoiceFingerprint({ supplierId, issueDate, currency, totalMinor }) {
  if (!supplierId || !issueDate || !currency || !Number.isSafeInteger(totalMinor)) return null;
  return createHash('sha256').update(`${supplierId}|${issueDate}|${currency}|${totalMinor}`).digest('hex');
}
