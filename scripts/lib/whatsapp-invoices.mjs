import { openDatabase } from './database.mjs';
import { lookupCustomer, assessCustomerReadiness } from './customer-registry.mjs';
import {
  calculateDueDate, createInvoiceConfirmationToken, createStandaloneInvoiceDraft, getInvoiceDraft
} from './invoice-drafts.mjs';
import { calculateLineItem } from './quotation-calculations.mjs';

const CURRENCIES = new Set(['MYR', 'SGD', 'USD']);

export class WhatsAppInvoiceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'WhatsAppInvoiceError';
    this.code = code;
  }
}

function fail(code) { throw new WhatsAppInvoiceError(code); }
function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}
function optional(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function date(value, name) {
  const text = required(value, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new TypeError(`${name} must use YYYY-MM-DD.`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) throw new TypeError(`${name} must be a real calendar date.`);
  return text;
}

export function parseMajorAmount(value, minorUnits = 2) {
  if (!Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) throw new TypeError('minorUnits must be an integer from 0 to 4.');
  const source = required(value, 'amount');
  if (source.includes(',') && !/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,4})?$/.test(source)) {
    throw new TypeError('amount contains invalid thousands separators.');
  }
  const text = source.replaceAll(',', '');
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,4})?$/.test(text)) throw new TypeError('amount must be a non-negative decimal string.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > minorUnits) throw new TypeError('amount has too many decimal places for the currency.');
  const factor = 10n ** BigInt(minorUnits);
  const minor = BigInt(whole) * factor + BigInt((fraction + '0'.repeat(minorUnits)).slice(0, minorUnits) || '0');
  const converted = Number(minor);
  if (!Number.isSafeInteger(converted)) throw new RangeError('amount exceeds the safe integer range.');
  return converted;
}

export function formatMinorAmount(value, currency, minorUnits = 2) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('value must be a non-negative safe integer.');
  const factor = 10n ** BigInt(minorUnits); const amount = BigInt(value);
  const whole = (amount / factor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (amount % factor).toString().padStart(minorUnits, '0');
  return `${currency} ${whole}${minorUnits ? `.${fraction}` : ''}`;
}

function sourceReference(value) {
  const reference = optional(value);
  if (!reference || reference.length > 160) throw new TypeError('sourceMessageReference is required and must not exceed 160 characters.');
  return reference;
}

function resolvePreparation(databasePath, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('input must be an object.');
  const lookup = lookupCustomer({ databasePath, query: required(input.customer, 'customer') });
  if (lookup.status === 'not_found') fail('CUSTOMER_NOT_FOUND');
  if (lookup.status === 'inactive') fail('CUSTOMER_INACTIVE');
  if (lookup.status !== 'resolved') fail('CUSTOMER_SELECTION_REQUIRED');
  const customer = lookup.customer;
  const currency = optional(input.currency)?.toUpperCase() ?? customer.default_currency;
  if (!currency) fail('CURRENCY_REQUIRED');
  if (!CURRENCIES.has(currency)) fail('CURRENCY_NOT_SUPPORTED');
  if (customer.default_currency && customer.default_currency !== currency) fail('CUSTOMER_CURRENCY_MISMATCH');
  const clientInitials = optional(input.clientInitials)?.toUpperCase() ?? customer.customer_code.toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(clientInitials)) fail('CLIENT_INITIALS_REQUIRED');
  if (input.taxMode !== 'NONE') fail('TAX_MODE_NOT_SUPPORTED');
  if (!Number.isInteger(input.paymentTermsDays) || input.paymentTermsDays < 0 || input.paymentTermsDays > 3650) {
    throw new TypeError('paymentTermsDays must be an integer from 0 to 3650.');
  }
  const issueDate = date(input.issueDate, 'issueDate');
  const serviceDate = date(input.serviceDate, 'serviceDate');
  calculateDueDate(issueDate, input.paymentTermsDays);
  if (!Array.isArray(input.lineItems) || input.lineItems.length < 1 || input.lineItems.length > 7) {
    throw new TypeError('lineItems must contain 1 to 7 items.');
  }
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const registry = database.prepare(`SELECT c.minor_units,c.invoice_template_id,c.default_bank_profile_id,
      b.id AS bank_id,b.business_entity_id,b.active AS bank_active,e.active AS entity_active
      FROM currencies c LEFT JOIN bank_profiles b ON b.id=c.default_bank_profile_id
      LEFT JOIN business_entities e ON e.id=b.business_entity_id WHERE c.code=? AND c.enabled=1`).get(currency);
    if (!registry) fail('CURRENCY_NOT_CONFIGURED');
    if (!registry.invoice_template_id) fail('INVOICE_TEMPLATE_NOT_CONFIGURED');
    if (!registry.bank_id || registry.bank_active !== 1 || registry.entity_active !== 1) fail('DEFAULT_BANK_PROFILE_NOT_CONFIGURED');
    const readiness = assessCustomerReadiness(customer, { currency, purchaseOrderNumber: optional(input.purchaseOrderNumber) });
    if (!readiness.ready) fail(`CUSTOMER_NOT_READY_${readiness.issues[0].toUpperCase()}`);
    const lineItems = input.lineItems.map((line, index) => {
      const item = {
        description: required(line?.description, `lineItems[${index}].description`),
        quantity: required(line?.quantity, `lineItems[${index}].quantity`),
        unit: optional(line?.unit),
        unit_price_minor: parseMajorAmount(line?.unitPrice, registry.minor_units)
      };
      calculateLineItem({ quantity: item.quantity, unitPriceMinor: item.unit_price_minor });
      return item;
    });
    return { customer, currency, clientInitials, issueDate, serviceDate, minorUnits: registry.minor_units, businessEntityId: registry.business_entity_id, lineItems };
  } finally { database.close(); }
}

function preview(draft, confirmation, minorUnits) {
  const snapshot = draft.snapshot;
  return {
    status: 'PENDING_CONFIRMATION',
    invoiceId: draft.id,
    customerCode: snapshot.customer.customerCode,
    currency: snapshot.currency,
    issueDate: snapshot.issueDate,
    serviceDate: snapshot.serviceDate,
    dueDate: snapshot.dueDate,
    paymentTermsDays: snapshot.paymentTermsDays,
    purchaseOrderNumber: snapshot.purchaseOrderNumber,
    clientInitials: snapshot.clientInitials,
    lineItems: snapshot.lineItems.map((line) => ({
      sequence: line.sequence, description: line.description, quantity: line.quantity, unit: line.unit,
      unitPrice: formatMinorAmount(line.unitPriceMinor, snapshot.currency, minorUnits),
      subtotal: formatMinorAmount(line.subtotalMinor, snapshot.currency, minorUnits)
    })),
    total: formatMinorAmount(snapshot.totals.totalMinor, snapshot.currency, minorUnits),
    confirmationToken: confirmation.token,
    expiresAt: confirmation.expiresAt
  };
}

export function prepareWhatsAppInvoice({
  databasePath, input, requestingUser, sourceChannel, sourceChat, sourceMessageReference,
  confirmationTtlMinutes = 15, now = new Date().toISOString(), tokenFactory
}) {
  const trusted = {
    requestingUser: required(requestingUser, 'requestingUser'), sourceChannel: required(sourceChannel, 'sourceChannel'),
    sourceChat: required(sourceChat, 'sourceChat'), sourceMessageReference: sourceReference(sourceMessageReference)
  };
  const resolved = resolvePreparation(databasePath, input);
  const draft = createStandaloneInvoiceDraft({ databasePath, actor: trusted.requestingUser, now, input: {
    customer_id: resolved.customer.id,
    business_entity_id: resolved.businessEntityId,
    currency: resolved.currency,
    issue_date: resolved.issueDate,
    payment_terms_days: input.paymentTermsDays,
    service_date: resolved.serviceDate,
    purchase_order_number: optional(input.purchaseOrderNumber),
    payment_terms: `${input.paymentTermsDays} day${input.paymentTermsDays === 1 ? '' : 's'}`,
    notes: optional(input.notes),
    client_initials: resolved.clientInitials,
    source_channel: trusted.sourceChannel,
    source_message_reference: trusted.sourceMessageReference,
    line_items: resolved.lineItems,
    discount: { type: 'NONE' },
    tax: { mode: 'NONE' }
  }});
  if (draft.snapshot.validationIssues.length) fail('INVOICE_DRAFT_INCOMPLETE');
  const confirmation = createInvoiceConfirmationToken({ databasePath, invoiceId: draft.id,
    requestingUser: trusted.requestingUser, sourceChannel: trusted.sourceChannel, sourceChat: trusted.sourceChat,
    sourceMessageReference: trusted.sourceMessageReference, ttlMinutes: confirmationTtlMinutes, now, tokenFactory });
  return preview(draft, confirmation, resolved.minorUnits);
}

function confirmationDraft(databasePath, token) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const row = database.prepare(`SELECT pc.draft_id,c.minor_units FROM pending_confirmations pc
      JOIN invoices i ON i.id=pc.draft_id JOIN currencies c ON c.code=i.currency
      WHERE pc.token=? AND pc.draft_type='invoice'`).get(token);
    if (!row) fail('CONFIRMATION_TOKEN_NOT_FOUND');
    return { draft: getInvoiceDraft({ databasePath, invoiceId: row.draft_id }), minorUnits: row.minor_units };
  } finally { database.close(); }
}

export function confirmWhatsAppInvoice({
  databasePath, token, confirmingUser, sourceChannel, sourceChat, root, outputRoot,
  testMode = false, documentRenderer, pdfConverter, pdfInspector, now = new Date().toISOString()
}) {
  const reference = confirmationDraft(databasePath, required(token, 'token'));
  const clientInitials = reference.draft.snapshot.clientInitials;
  if (!clientInitials) fail('CLIENT_INITIALS_NOT_BOUND');
  return import('./invoice-issuance.mjs')
    .then(({ issueConfirmedInvoice }) => issueConfirmedInvoice({ databasePath, token, confirmingUser, sourceChannel, sourceChat, clientInitials,
      root, outputRoot, testMode, documentRenderer, pdfConverter, pdfInspector, now }))
    .then((issued) => ({
      status: 'ISSUED',
      invoiceId: issued.invoice_id,
      invoiceNumber: issued.invoice_number,
      currency: reference.draft.snapshot.currency,
      total: formatMinorAmount(reference.draft.snapshot.totals.totalMinor, reference.draft.snapshot.currency, reference.minorUnits),
      dueDate: reference.draft.snapshot.dueDate,
      pdfReady: Boolean(issued.pdf_relative_path || issued.drive_pdf_file_id),
      storage: issued.storage_backend ?? 'LOCAL',
      customerDeliveryRequiresSeparateConfirmation: true
    }));
}
