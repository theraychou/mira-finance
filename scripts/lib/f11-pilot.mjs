import { openDatabase } from './database.mjs';
import { migrateUp } from './migrations.mjs';
import {
  createQuotationConfirmationToken,
  createQuotationDraft,
  reviseQuotationDraft
} from './quotation-drafts.mjs';
import { issueConfirmedQuotation } from './quotation-issuance.mjs';
import {
  createInvoiceConfirmationToken,
  createInvoiceDraftFromQuotation
} from './invoice-drafts.mjs';
import { issueConfirmedInvoice } from './invoice-issuance.mjs';
import { confirmPaymentStatus, createPaymentStatusDraft } from './invoice-payments.mjs';
import { uploadIssuedDocument } from './drive-uploads.mjs';
import { generateMonthlyTestReport } from './monthly-report.mjs';

const DEFINITIONS = [
  { currency: 'MYR', bankProfileId: 'cimb-myr', quotationTemplateId: 'quotation-myr', invoiceTemplateId: 'invoice-myr', bankName: 'CIMB Bank', initials: 'FM', unitPriceMinor: 10500, quotationToken: 'A', invoiceToken: 'D', paymentToken: 'G' },
  { currency: 'SGD', bankProfileId: 'maybank-sgd', quotationTemplateId: 'quotation-sgd', invoiceTemplateId: 'invoice-sgd', bankName: 'Maybank', initials: 'FS', unitPriceMinor: 20500, quotationToken: 'B', invoiceToken: 'E', paymentToken: 'H' },
  { currency: 'USD', bankProfileId: 'wise-usd', quotationTemplateId: 'quotation-usd', invoiceTemplateId: 'invoice-usd', bankName: 'Wise', initials: 'FU', unitPriceMinor: 30500, quotationToken: 'C', invoiceToken: 'F', paymentToken: 'J' }
];

function clock(base) {
  const start = new Date(base);
  if (Number.isNaN(start.valueOf()) || start.toISOString() !== base) throw new TypeError('baseNow must be an ISO-8601 UTC instant.');
  let minute = 0;
  return () => new Date(start.valueOf() + minute++ * 60000).toISOString();
}

function seedPilotLedger(databasePath, now) {
  const database = openDatabase(databasePath);
  try {
    for (const table of ['business_entities', 'customers', 'quotations', 'invoices', 'document_numbers']) {
      if (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count !== 0) throw new Error('F11_PILOT_LEDGER_NOT_EMPTY');
    }
    const entityId = Number(database.prepare(`
      INSERT INTO business_entities
        (legal_name, trading_name, default_currency, active, created_at, updated_at)
      VALUES ('TEST Finance Entity — TEST / NOT VALID', 'TEST Finance Entity', 'MYR', 1, ?, ?)
    `).run(now, now).lastInsertRowid);
    const customers = {};
    for (const definition of DEFINITIONS) {
      customers[definition.currency] = Number(database.prepare(`
        INSERT INTO customers
          (customer_code, legal_name, display_name, billing_address, billing_contact_name,
           billing_email, default_currency, default_payment_terms_days, active, created_at, updated_at)
        VALUES (?, ?, ?, 'TEST ADDRESS — NOT VALID', 'TEST Contact', 'finance-pilot@example.invalid', ?, 30, 1, ?, ?)
      `).run(
        `TEST-F11-${definition.currency}`,
        `TEST ${definition.currency} Customer — TEST / NOT VALID`,
        `TEST ${definition.currency} Customer`,
        definition.currency,
        now,
        now
      ).lastInsertRowid);
      database.prepare(`
        INSERT INTO bank_profiles
          (id, display_name, business_entity_id, currency, bank_name, account_name,
           account_number, active, created_at, updated_at)
        VALUES (?, 'TEST / NOT VALID', ?, ?, ?, 'TEST ACCOUNT — NOT VALID', 'TEST-0000000000', 1, ?, ?)
      `).run(definition.bankProfileId, entityId, definition.currency, definition.bankName, now, now);
      database.prepare(`
        UPDATE currencies SET default_bank_profile_id = ?, updated_at = ? WHERE code = ?
      `).run(definition.bankProfileId, now, definition.currency);
    }
    return { entityId, customers };
  } finally {
    database.close();
  }
}

function quotationInput({ definition, entityId, customerId, issueDate, revision }) {
  const lineItems = [{
    description: `TEST ${definition.currency} finance service — NOT VALID`,
    quantity: '1',
    unit: 'lot',
    unit_price_minor: definition.unitPriceMinor
  }];
  if (revision) lineItems.push({
    description: 'TEST revision line — NOT VALID',
    quantity: '1',
    unit: 'item',
    unit_price_minor: 2500
  });
  return {
    customer_id: customerId,
    business_entity_id: entityId,
    currency: definition.currency,
    issue_date: issueDate,
    validity_days: 30,
    service_date: issueDate,
    title: `TEST / NOT VALID — ${definition.currency} pilot quotation${revision ? ' revised' : ''}`,
    description: 'Synthetic F11 pilot data only',
    payment_terms: '30 days — TEST ONLY',
    notes: 'TEST / NOT VALID',
    source_channel: 'f11-pilot',
    source_message_reference: `f11-test-${definition.currency.toLowerCase()}`,
    line_items: lineItems,
    discount: { type: 'NONE' },
    tax: { mode: 'NONE' }
  };
}

function assertDefinition(snapshot, definition, documentType) {
  const template = documentType === 'quotation' ? snapshot.quotationTemplateId : snapshot.invoiceTemplateId;
  const expected = documentType === 'quotation' ? definition.quotationTemplateId : definition.invoiceTemplateId;
  if (template !== expected || snapshot.bankProfileId !== definition.bankProfileId || snapshot.currency !== definition.currency) {
    throw new Error('F11_CURRENCY_TEMPLATE_BANK_MISMATCH');
  }
}

function assertUpload(upload, driveConfiguration) {
  if (upload.status !== 'COMPLETED' || upload.uploads.length !== 2) throw new Error('F11_DRIVE_UPLOAD_INCOMPLETE');
  if (upload.uploads.some((item) => item.status !== 'COMPLETED' || item.folder_id !== driveConfiguration.rootFolderId || !item.drive_file_id)) {
    throw new Error('F11_DRIVE_UPLOAD_VERIFICATION_FAILED');
  }
}

export function verifyF11PilotLedger({ databasePath }) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const quotations = database.prepare(`
      SELECT q.*, qds.snapshot_json, qi.status AS issuance_status
      FROM quotations q
      JOIN quotation_draft_state qds ON qds.quotation_id = q.id
      JOIN quotation_issuances qi ON qi.quotation_id = q.id
      ORDER BY q.id
    `).all();
    const invoices = database.prepare(`
      SELECT i.*, ids.snapshot_json, ii.status AS issuance_status
      FROM invoices i
      JOIN invoice_draft_state ids ON ids.invoice_id = i.id
      JOIN invoice_issuances ii ON ii.invoice_id = i.id
      ORDER BY i.id
    `).all();
    if (quotations.length !== 3 || invoices.length !== 3) throw new Error('F11_DOCUMENT_COUNT_MISMATCH');
    const numbers = database.prepare("SELECT document_number FROM document_numbers WHERE status = 'ISSUED' ORDER BY id").all();
    if (numbers.length !== 6 || new Set(numbers.map((row) => row.document_number)).size !== 6) throw new Error('F11_NUMBERING_MISMATCH');
    const uploads = database.prepare("SELECT * FROM drive_uploads WHERE status = 'COMPLETED' ORDER BY id").all();
    if (uploads.length !== 12 || uploads.some((row) => !row.drive_file_id)) throw new Error('F11_DRIVE_LEDGER_MISMATCH');
    if (database.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE result = 'FAIL'").get().count !== 0) throw new Error('F11_FAILED_AUDIT_EVENT');
    for (const definition of DEFINITIONS) {
      const quotation = quotations.find((row) => row.currency === definition.currency);
      const invoice = invoices.find((row) => row.currency === definition.currency);
      if (!quotation || !invoice || quotation.status !== 'ISSUED' || quotation.issuance_status !== 'ISSUED') throw new Error('F11_QUOTATION_STATE_MISMATCH');
      if (invoice.status !== 'ISSUED' || invoice.issuance_status !== 'ISSUED' || invoice.payment_status !== 'PAID' || invoice.balance_due_minor !== 0) throw new Error('F11_INVOICE_STATE_MISMATCH');
      if (invoice.quotation_id !== quotation.id || invoice.total_minor !== quotation.total_minor) throw new Error('F11_QUOTATION_INVOICE_TOTAL_MISMATCH');
      assertDefinition(JSON.parse(quotation.snapshot_json), definition, 'quotation');
      assertDefinition(JSON.parse(invoice.snapshot_json), definition, 'invoice');
      for (const [entityType, entityId, required] of [
        ['quotation', quotation.id, ['quotation.draft_created', 'quotation.draft_revised', 'quotation.confirmation_requested', 'quotation.issuance_started', 'quotation.issued', 'drive.upload_queued', 'drive.upload_completed']],
        ['invoice', invoice.id, ['invoice.draft_created', 'invoice.confirmation_requested', 'invoice.issuance_started', 'invoice.issued', 'invoice.payment_confirmation_requested', 'invoice.payment_recorded', 'drive.upload_queued', 'drive.upload_completed']]
      ]) {
        const actions = new Set(database.prepare('SELECT action FROM audit_events WHERE entity_type = ? AND entity_id = ?').all(entityType, entityId).map((row) => row.action));
        if (required.some((action) => !actions.has(action))) throw new Error('F11_AUDIT_TRAIL_INCOMPLETE');
      }
    }
    return { quotationCount: 3, invoiceCount: 3, paidInvoiceCount: 3, issuedNumberCount: 6, completedDriveUploadCount: 12 };
  } finally {
    database.close();
  }
}

export async function runF11Pilot({
  databasePath,
  storageRoot,
  templateRoot,
  driveConfiguration,
  driveClient,
  pdfConverter,
  pdfInspector,
  baseNow = '2026-07-30T07:00:00.000Z'
}) {
  const nextTime = clock(baseNow);
  const initialTime = nextTime();
  await migrateUp({ databasePath, now: () => initialTime });
  const ids = seedPilotLedger(databasePath, initialTime);
  const issueDate = initialTime.slice(0, 10);
  const actor = 'f11-pilot-authorised-user';
  const sourceChannel = 'f11-pilot';
  const sourceChat = 'f11-test-context';
  const results = [];

  for (const definition of DEFINITIONS) {
    const first = createQuotationDraft({
      databasePath,
      input: quotationInput({ definition, entityId: ids.entityId, customerId: ids.customers[definition.currency], issueDate, revision: false }),
      actor,
      now: nextTime()
    });
    const revised = reviseQuotationDraft({
      databasePath,
      quotationId: first.id,
      input: quotationInput({ definition, entityId: ids.entityId, customerId: ids.customers[definition.currency], issueDate, revision: true }),
      actor,
      now: nextTime()
    });
    assertDefinition(revised.snapshot, definition, 'quotation');
    const quotationToken = `QD-${definition.quotationToken.repeat(10)}`;
    createQuotationConfirmationToken({
      databasePath,
      quotationId: revised.id,
      requestingUser: actor,
      sourceChannel,
      sourceChat,
      sourceMessageReference: `f11-confirm-q-${definition.currency.toLowerCase()}`,
      tokenFactory: () => quotationToken,
      now: nextTime()
    });
    const quotation = await issueConfirmedQuotation({
      databasePath,
      token: quotationToken,
      confirmingUser: actor,
      sourceChannel,
      sourceChat,
      clientInitials: definition.initials,
      root: templateRoot,
      outputRoot: `${storageRoot}/generated/quotations`,
      testMode: true,
      pdfConverter,
      pdfInspector,
      now: nextTime()
    });
    const quotationUpload = await uploadIssuedDocument({
      databasePath,
      documentType: 'quotation',
      entityId: revised.id,
      actor,
      root: storageRoot,
      configuration: driveConfiguration,
      client: driveClient,
      now: nextTime()
    });
    assertUpload(quotationUpload, driveConfiguration);

    const invoiceDraft = createInvoiceDraftFromQuotation({
      databasePath,
      quotationId: revised.id,
      issueDate,
      paymentTermsDays: 30,
      paymentTerms: '30 days — TEST ONLY',
      purchaseOrderNumber: `TEST-PO-${definition.currency}`,
      actor,
      sourceChannel,
      sourceMessageReference: `f11-invoice-${definition.currency.toLowerCase()}`,
      now: nextTime()
    });
    assertDefinition(invoiceDraft.snapshot, definition, 'invoice');
    const invoiceToken = `ID-${definition.invoiceToken.repeat(10)}`;
    createInvoiceConfirmationToken({
      databasePath,
      invoiceId: invoiceDraft.id,
      requestingUser: actor,
      sourceChannel,
      sourceChat,
      sourceMessageReference: `f11-confirm-i-${definition.currency.toLowerCase()}`,
      tokenFactory: () => invoiceToken,
      now: nextTime()
    });
    const invoice = await issueConfirmedInvoice({
      databasePath,
      token: invoiceToken,
      confirmingUser: actor,
      sourceChannel,
      sourceChat,
      clientInitials: definition.initials,
      root: templateRoot,
      outputRoot: `${storageRoot}/generated/invoices`,
      testMode: true,
      pdfConverter,
      pdfInspector,
      now: nextTime()
    });
    const invoiceUpload = await uploadIssuedDocument({
      databasePath,
      documentType: 'invoice',
      entityId: invoiceDraft.id,
      actor,
      root: storageRoot,
      configuration: driveConfiguration,
      client: driveClient,
      now: nextTime()
    });
    assertUpload(invoiceUpload, driveConfiguration);
    const paymentToken = `PM-${definition.paymentToken.repeat(10)}`;
    createPaymentStatusDraft({
      databasePath,
      invoiceId: invoiceDraft.id,
      amountMinor: invoiceDraft.snapshot.totals.totalMinor,
      paymentDate: issueDate,
      paymentReference: `TEST-PAYMENT-${definition.currency}`,
      requestingUser: actor,
      sourceChannel,
      sourceChat,
      sourceMessageReference: `f11-payment-${definition.currency.toLowerCase()}`,
      tokenFactory: () => paymentToken,
      now: nextTime()
    });
    const payment = confirmPaymentStatus({
      databasePath,
      token: paymentToken,
      confirmingUser: actor,
      sourceChannel,
      sourceChat,
      now: nextTime()
    });
    if (payment.paymentStatus !== 'PAID' || payment.balanceDueMinor !== 0) throw new Error('F11_PAYMENT_CONFIRMATION_FAILED');
    results.push({
      currency: definition.currency,
      quotationId: revised.id,
      quotationNumber: quotation.quotation_number,
      invoiceId: invoiceDraft.id,
      invoiceNumber: invoice.invoice_number,
      totalMinor: invoiceDraft.snapshot.totals.totalMinor,
      paymentStatus: payment.paymentStatus
    });
  }

  const verification = verifyF11PilotLedger({ databasePath });
  const monthly = await generateMonthlyTestReport({
    databasePath,
    month: issueDate.slice(0, 7),
    generatedAt: nextTime(),
    actor,
    outputRoot: `${storageRoot}/generated/reports`
  });
  return { phase: 'F11', classification: 'TEST / NOT VALID', issueDate, results, verification, monthlyReport: monthly };
}
