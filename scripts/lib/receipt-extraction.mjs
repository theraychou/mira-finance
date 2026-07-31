import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const currencies = new Set(['MYR', 'SGD', 'USD']);

function cleanText(value) {
  return typeof value === 'string' ? value.replaceAll('\u0000', '').replace(/\r\n?/g, '\n').slice(0, 250_000) : '';
}

async function runPdfText(filePath) {
  const { stdout } = await execFileAsync('pdftotext', ['-layout', '-nopgbrk', filePath, '-'], {
    timeout: 30_000,
    maxBuffer: 512 * 1024,
    windowsHide: true
  });
  return { text: stdout, rotationDegrees: 0, confidence: null };
}

async function runTesseract(filePath) {
  const { stdout } = await execFileAsync('tesseract', [filePath, 'stdout', '--psm', '6'], {
    timeout: 60_000,
    maxBuffer: 512 * 1024,
    windowsHide: true
  });
  return { text: stdout, rotationDegrees: 0, confidence: null };
}

export async function extractReceiptText({
  filePath,
  mimeType,
  advisoryText = null,
  pdfRunner = runPdfText,
  imageRunner = runTesseract
}) {
  if (advisoryText) {
    const text = cleanText(advisoryText);
    return { method: 'ADVISORY', status: text ? 'COMPLETE' : 'UNAVAILABLE', text, rotationDegrees: 0, confidence: null };
  }
  const isPdf = mimeType === 'application/pdf';
  try {
    const result = await (isPdf ? pdfRunner(filePath) : imageRunner(filePath));
    const text = cleanText(result?.text);
    return {
      method: isPdf ? 'PDF_TEXT' : 'TESSERACT',
      status: text.trim() ? 'COMPLETE' : 'PARTIAL',
      text,
      rotationDegrees: [0, 90, 180, 270].includes(result?.rotationDegrees) ? result.rotationDegrees : 0,
      confidence: Number.isFinite(result?.confidence) ? result.confidence : null
    };
  } catch (error) {
    if (!isPdf && error?.code === 'ENOENT') return { method: 'UNAVAILABLE', status: 'UNAVAILABLE', text: '', rotationDegrees: 0, confidence: null };
    return { method: isPdf ? 'PDF_TEXT' : 'TESSERACT', status: 'FAILED', text: '', rotationDegrees: 0, confidence: null };
  }
}

function parseDate(text) {
  const iso = /\b(20\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /\b(0?[1-9]|[12]\d|3[01])[-/.](0?[1-9]|1[0-2])[-/.](20\d{2})\b/.exec(text);
  if (!dmy) return null;
  return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
}

function parseCurrency(text) {
  const upper = text.toUpperCase();
  if (/\bMYR\b|RM\s*\d/.test(upper)) return 'MYR';
  if (/\bSGD\b|S\$\s*\d/.test(upper)) return 'SGD';
  if (/\bUSD\b|US\$\s*\d/.test(upper)) return 'USD';
  return null;
}

function parseMinorAmount(text) {
  const matches = [...text.matchAll(/(?:TOTAL|AMOUNT\s+DUE|GRAND\s+TOTAL)\s*[:\-]?\s*(?:MYR|SGD|USD|RM|S\$|US\$|\$)?\s*([0-9][0-9,]*)(?:\.([0-9]{1,2}))?/gi)];
  const match = matches.at(-1);
  if (!match) return null;
  const whole = Number(match[1].replaceAll(',', ''));
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const value = whole * 100 + Number(fraction || 0);
  return Number.isSafeInteger(value) ? value : null;
}

function merchantLine(text) {
  return text.split('\n').map((line) => line.trim()).find((line) =>
    line.length >= 2 && line.length <= 120 && !/TEST\s*\/\s*NOT VALID/i.test(line) &&
    !/^(?:TOTAL|AMOUNT\s+DUE|GRAND\s+TOTAL)\b/i.test(line) && !/^\d/.test(line)
  ) ?? null;
}

export function extractReceiptFields({ text, categories = [], advisoryFields = {} }) {
  const safeText = cleanText(text);
  const candidate = {
    transactionDate: advisoryFields.transactionDate ?? parseDate(safeText),
    merchant: advisoryFields.merchant ?? merchantLine(safeText),
    currency: advisoryFields.currency ? String(advisoryFields.currency).toUpperCase() : parseCurrency(safeText),
    totalMinor: advisoryFields.totalMinor ?? parseMinorAmount(safeText),
    taxMinor: advisoryFields.taxMinor ?? 0
  };
  if (candidate.currency && !currencies.has(candidate.currency)) candidate.currency = null;
  const normalized = safeText.toLowerCase();
  const mapped = categories.find((category) => category.terms.some((term) => normalized.includes(term.toLowerCase())));
  candidate.category = advisoryFields.category ?? mapped?.id ?? null;
  candidate.textSha256 = safeText ? createHash('sha256').update(safeText).digest('hex') : null;
  return candidate;
}

export function probableReceiptFingerprint({ merchant, transactionDate, currency, totalMinor }) {
  if (!merchant || !transactionDate || !currency || !Number.isSafeInteger(totalMinor)) return null;
  const normalizedMerchant = merchant.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(`${normalizedMerchant}|${transactionDate}|${currency}|${totalMinor}`).digest('hex');
}
