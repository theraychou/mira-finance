#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './lib/database.mjs';
import { verifyF11PilotLedger } from './lib/f11-pilot.mjs';
import { inspectPdf } from './lib/quotation-renderer.mjs';
import { readDocumentXml } from './lib/template-contract.mjs';
import { repositoryRoot } from './validate-config.mjs';

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
function privateMode(metadata) { return (metadata.mode & 0o077) === 0; }

export async function verifyF11PilotArtifacts({
  root = repositoryRoot,
  databasePath = path.join(root, 'data', 'pilots', 'f11-pilot.sqlite3'),
  pdfInspector = inspectPdf
} = {}) {
  const summary = verifyF11PilotLedger({ databasePath });
  const database = openDatabase(databasePath, { readOnly: true });
  let issuances;
  try {
    issuances = [
      ...database.prepare("SELECT 'quotation' AS type, docx_relative_path, pdf_relative_path, docx_sha256, pdf_sha256 FROM quotation_issuances WHERE status='ISSUED'").all(),
      ...database.prepare("SELECT 'invoice' AS type, docx_relative_path, pdf_relative_path, docx_sha256, pdf_sha256 FROM invoice_issuances WHERE status='ISSUED'").all()
    ];
    if (database.prepare(`
      SELECT COUNT(*) AS count FROM customers
      WHERE legal_name NOT LIKE '%TEST / NOT VALID%'
        OR billing_address NOT LIKE '%TEST%'
        OR billing_address NOT LIKE '%NOT VALID%'
    `).get().count !== 0) throw new Error('F11_NON_TEST_CUSTOMER_FOUND');
    if (database.prepare("SELECT COUNT(*) AS count FROM bank_profiles WHERE account_number NOT LIKE 'TEST-%'").get().count !== 0) throw new Error('F11_NON_TEST_BANK_VALUE_FOUND');
  } finally {
    database.close();
  }
  if (issuances.length !== 6) throw new Error('F11_ISSUANCE_ARTIFACT_COUNT_MISMATCH');
  for (const issuance of issuances) {
    const directory = issuance.type === 'quotation' ? 'quotations' : 'invoices';
    const docxPath = path.join(root, 'generated', directory, issuance.docx_relative_path);
    const pdfPath = path.join(root, 'generated', directory, issuance.pdf_relative_path);
    const [docx, pdf, docxStat, pdfStat, inspection] = await Promise.all([
      readFile(docxPath), readFile(pdfPath), stat(docxPath), stat(pdfPath), pdfInspector({ pdfPath })
    ]);
    if (sha256(docx) !== issuance.docx_sha256 || sha256(pdf) !== issuance.pdf_sha256) throw new Error('F11_ARTIFACT_HASH_MISMATCH');
    if (!privateMode(docxStat) || !privateMode(pdfStat)) throw new Error('F11_ARTIFACT_PERMISSION_MISMATCH');
    if (!readDocumentXml(docx).xml.includes('TEST / NOT VALID') || !String(inspection.text).includes('TEST / NOT VALID')) throw new Error('F11_TEST_MARKING_MISSING');
    if (!inspection.a4 || inspection.pageCount !== 1) throw new Error('F11_PDF_LAYOUT_MISMATCH');
  }
  const reportPath = path.join(root, 'generated', 'reports', '2026', '07', 'f11-monthly-report.test.json');
  const [reportBuffer, reportStat] = await Promise.all([readFile(reportPath), stat(reportPath)]);
  const report = JSON.parse(reportBuffer.toString('utf8'));
  if (report.classification !== 'TEST / NOT VALID' || report.currencyPolicy !== 'NO_CONVERSION') throw new Error('F11_REPORT_CLASSIFICATION_MISMATCH');
  if (report.currencies.map((item) => item.currency).join(',') !== 'MYR,SGD,USD') throw new Error('F11_REPORT_CURRENCY_MISMATCH');
  if (!privateMode(reportStat)) throw new Error('F11_REPORT_PERMISSION_MISMATCH');
  const reportDatabase = openDatabase(databasePath, { readOnly: true });
  try {
    const event = reportDatabase.prepare("SELECT after_hash FROM audit_events WHERE action='report.monthly_test_generated'").get();
    if (!event || event.after_hash !== sha256(reportBuffer)) throw new Error('F11_REPORT_AUDIT_HASH_MISMATCH');
  } finally {
    reportDatabase.close();
  }
  return { ...summary, validatedArtifactCount: 12, reportValidated: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyF11PilotArtifacts().then((result) => {
    console.log(`PASS F11 pilot verified: ${result.quotationCount} quotations, ${result.invoiceCount} paid invoices, ${result.validatedArtifactCount} private A4 artifacts, monthly report valid`);
  }).catch((error) => {
    console.error(`FAIL F11 pilot verification failed (${error?.code ?? error?.message ?? 'F11_VERIFY_FAILED'})`);
    process.exitCode = 1;
  });
}
