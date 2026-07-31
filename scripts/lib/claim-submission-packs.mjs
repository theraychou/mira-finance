import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import PizZip from 'pizzip';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { canonicalJson } from './quotation-drafts.mjs';
import { publishImmutableBuffer } from './quotation-renderer.mjs';
import { repositoryRoot } from '../validate-config.mjs';

const CURRENCIES = ['MYR', 'SGD', 'USD'];
const ZIP_DATE = new Date('2000-01-01T00:00:00.000Z');

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}
function positiveId(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new TypeError(`${name} must be a positive integer.`);
  return result;
}
function instant(value) {
  const parsed = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new TypeError('now must be an ISO-8601 UTC instant.');
}
function monthRange(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) throw new TypeError('month must use YYYY-MM.');
  const start = `${month}-01`;
  const parsed = new Date(`${start}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 7) !== month) throw new TypeError('month must be a real calendar month.');
  parsed.setUTCMonth(parsed.getUTCMonth() + 1);
  return { start, endExclusive: parsed.toISOString().slice(0, 10) };
}
function csv(value) {
  if (value == null) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function safeRootFile(root, relative) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relative);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('CLAIM_RECEIPT_PATH_INVALID');
  return candidate;
}

export async function generateClaimSubmissionPack({
  databasePath, customerId, month, actor, testMode = false, now = new Date().toISOString(),
  root = repositoryRoot, outputRoot = path.join(root, 'generated', 'reports', 'claim-submissions')
}) {
  required(actor, 'actor'); instant(now);
  const range = monthRange(month);
  const database = openDatabase(databasePath, { readOnly: true });
  let customer;
  let rows;
  try {
    customer = database.prepare('SELECT id,customer_code,display_name FROM customers WHERE id=? AND active=1').get(positiveId(customerId, 'customer_id'));
    if (!customer) throw new Error('CLAIM_PACK_CUSTOMER_NOT_FOUND_OR_INACTIVE');
    if (database.prepare('SELECT id FROM claim_submission_packs WHERE customer_id=? AND month=?').get(customer.id, month)) throw new Error('CLAIM_PACK_ALREADY_EXISTS');
    rows = database.prepare(`SELECT r.id AS recharge_id,r.claim_id,r.project_reference,r.description,r.currency,r.amount_minor,r.status,
      c.claim_number,c.transaction_date,c.merchant,c.category,cr.source_sha256,cr.source_mime_type,cr.storage_relative_path
      FROM claim_recharges r JOIN claims c ON c.id=r.claim_id JOIN claim_receipts cr ON cr.claim_id=c.id
      WHERE r.customer_id=? AND c.status='FILED' AND c.transaction_date>=? AND c.transaction_date<?
        AND r.status IN ('APPROVED','INVOICED')
      ORDER BY c.transaction_date,c.id`).all(customer.id, range.start, range.endExclusive);
  } finally { database.close(); }
  if (!rows.length) throw new Error('CLAIM_PACK_HAS_NO_ELIGIBLE_CLAIMS');

  const classification = testMode ? 'TEST / NOT VALID' : 'OPERATIONAL';
  const totals = CURRENCIES.map((currency) => ({
    currency,
    totalMinor: rows.filter((row) => row.currency === currency).reduce((sum, row) => sum + row.amount_minor, 0)
  }));
  const zip = new PizZip();
  const summaryHeaders = ['classification', 'claim_number', 'transaction_date', 'merchant', 'category', 'project_reference', 'description', 'currency', 'amount_minor', 'status'];
  const summary = [
    summaryHeaders.join(','),
    ...rows.map((row) => summaryHeaders.map((header) => csv(header === 'classification' ? classification : row[header])).join(','))
  ].join('\r\n') + '\r\n';
  zip.file('summary.csv', summary, { date: ZIP_DATE });
  zip.file('manifest.json', `${canonicalJson({
    schemaVersion: 1, phase: 'F14', classification, customerCode: customer.customer_code,
    customerName: customer.display_name, month, generatedAt: now, currencyPolicy: 'NO_CONVERSION',
    claimCount: rows.length, currencyTotals: totals,
    items: rows.map((row) => ({ claimId: row.claim_id, claimNumber: row.claim_number, receiptSha256: row.source_sha256 }))
  })}\n`, { date: ZIP_DATE });
  for (const row of rows) {
    const sourcePath = safeRootFile(path.join(root, 'data', 'claims', 'originals'), row.storage_relative_path);
    const buffer = await readFile(sourcePath);
    if (createHash('sha256').update(buffer).digest('hex') !== row.source_sha256) throw new Error('CLAIM_PACK_RECEIPT_HASH_MISMATCH');
    const extension = path.extname(row.storage_relative_path).toLowerCase();
    zip.file(`receipts/claim-${row.claim_id}-${row.source_sha256.slice(0, 12)}${extension}`, buffer, { date: ZIP_DATE });
  }
  const buffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  const hash = createHash('sha256').update(buffer).digest('hex');
  const customerCode = customer.customer_code.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-');
  const relativePath = path.join(month.slice(0, 4), month.slice(5, 7), customerCode, `claim-submission-${month}-${hash.slice(0, 12)}.zip`);
  const filePath = path.join(outputRoot, relativePath);
  await publishImmutableBuffer(filePath, buffer);
  try {
    const writable = openDatabase(databasePath);
    try {
      return withImmediateTransaction(writable, () => {
        const pack = writable.prepare(`INSERT INTO claim_submission_packs
          (customer_id,month,status,classification,relative_path,sha256,size_bytes,currency_totals_json,claim_count,created_by,created_at,ready_at)
          VALUES (?,?,'READY',?,?,?,?,?,?,?,?,?)`).run(
          customer.id, month, classification, relativePath.split(path.sep).join('/'), hash, buffer.length,
          canonicalJson(totals), rows.length, actor, now, now
        );
        const packId = Number(pack.lastInsertRowid);
        for (const row of rows) {
          writable.prepare(`INSERT INTO claim_submission_pack_items
            (pack_id,claim_recharge_id,claim_id,receipt_sha256,amount_minor,currency,created_at)
            VALUES (?,?,?,?,?,?,?)`).run(packId, row.recharge_id, row.claim_id, row.source_sha256, row.amount_minor, row.currency, now);
          writable.prepare(`INSERT INTO claim_recharge_events
            (claim_recharge_id,from_status,to_status,actor,details_json,occurred_at)
            VALUES (?,?,?,?,?,?)`).run(row.recharge_id, row.status, row.status, actor, canonicalJson({ packId, month, action: 'included_in_ready_pack' }), now);
        }
        writable.prepare(`INSERT INTO audit_events
          (timestamp,actor,action,entity_type,entity_id,after_hash,result,details_json)
          VALUES (?,?,'claim_submission_pack.generated','claim_submission_pack',?,?,'PASS',?)`).run(
          now, actor, packId, hash, canonicalJson({ customerId: customer.id, month, claimCount: rows.length, classification })
        );
        return { packId, status: 'READY', classification, hash, size: buffer.length, claimCount: rows.length, currencyTotals: totals, relativePath: relativePath.split(path.sep).join('/'), filePath };
      });
    } finally { writable.close(); }
  } catch (error) {
    await rm(filePath, { force: true });
    throw error;
  }
}

export function getClaimSubmissionPackRegister({ databasePath, customerId = null }) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    return customerId == null
      ? database.prepare('SELECT * FROM claim_submission_packs ORDER BY month,id').all()
      : database.prepare('SELECT * FROM claim_submission_packs WHERE customer_id=? ORDER BY month,id').all(positiveId(customerId, 'customer_id'));
  } finally { database.close(); }
}

export function markClaimSubmissionPackSubmitted({
  databasePath, packId, submittingUser, authorisedUser, submissionReference, now = new Date().toISOString()
}) {
  if (required(submittingUser, 'submitting_user') !== required(authorisedUser, 'authorised_user')) {
    throw new Error('CLAIM_PACK_SUBMISSION_UNAUTHORISED');
  }
  instant(now);
  const reference = required(submissionReference, 'submission_reference');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const pack = database.prepare('SELECT * FROM claim_submission_packs WHERE id=?').get(positiveId(packId, 'pack_id'));
      if (!pack || pack.status !== 'READY') throw new Error('CLAIM_PACK_NOT_READY');
      database.prepare("UPDATE claim_submission_packs SET status='SUBMITTED',submitted_at=? WHERE id=?").run(now, pack.id);
      database.prepare(`INSERT INTO audit_events
        (timestamp,actor,action,entity_type,entity_id,result,details_json)
        VALUES (?,?,'claim_submission_pack.submitted','claim_submission_pack',?,'PASS',?)`).run(
        now, submittingUser, pack.id, canonicalJson({ submissionReference: reference })
      );
      return database.prepare('SELECT * FROM claim_submission_packs WHERE id=?').get(pack.id);
    });
  } finally { database.close(); }
}
