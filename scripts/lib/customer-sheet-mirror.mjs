import { createHash } from 'node:crypto';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { recordHash } from './registry-audit.mjs';

const HEADERS = [
  'Customer code', 'Legal name', 'Display name', 'Aliases', 'Registration number', 'Tax registration number',
  'Billing address', 'Billing contact', 'Billing email', 'Billing phone', 'Default currency',
  'Payment terms (days)', 'Tax treatment', 'PO required', 'Status', 'Notes', 'Invoice readiness', 'Created at', 'Last updated'
];

function customerRows(databasePath) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const customers = database.prepare('SELECT * FROM customers ORDER BY customer_code').all();
    const aliases = database.prepare('SELECT customer_id,alias FROM customer_aliases ORDER BY customer_id,normalized_alias').all();
    const byCustomer = new Map();
    for (const item of aliases) {
      if (!byCustomer.has(item.customer_id)) byCustomer.set(item.customer_id, []);
      byCustomer.get(item.customer_id).push(item.alias);
    }
    return customers.map((customer) => ({ ...customer, aliases: byCustomer.get(customer.id) ?? [] }));
  } finally { database.close(); }
}

function readiness(customer) {
  const issues = [];
  if (customer.active !== 1) issues.push('inactive');
  if (!customer.legal_name) issues.push('missing legal name');
  if (!customer.billing_address) issues.push('missing billing address');
  if (!customer.default_currency) issues.push('missing currency');
  if (customer.default_payment_terms_days === null) issues.push('missing payment terms');
  if (!customer.tax_treatment) issues.push('missing tax treatment');
  return issues.length ? `NOT READY: ${issues.join(', ')}` : 'READY';
}

export function buildCustomerSheetValues(customers, now) {
  const rows = customers.map((customer) => [
    customer.customer_code,
    customer.legal_name ?? '',
    customer.display_name,
    customer.aliases.join(', '),
    customer.registration_number ?? '',
    customer.tax_registration_number ?? '',
    customer.billing_address ?? '',
    customer.billing_contact_name ?? '',
    customer.billing_email ?? '',
    customer.billing_phone ?? '',
    customer.default_currency ?? '',
    customer.default_payment_terms_days ?? '',
    customer.tax_treatment ?? '',
    customer.purchase_order_required === 1 ? 'YES' : 'NO',
    customer.active === 1 ? 'ACTIVE' : 'INACTIVE',
    customer.notes ?? '',
    readiness(customer),
    customer.created_at,
    customer.updated_at
  ]);
  const pad = (first) => [first, ...Array(HEADERS.length - 1).fill('')];
  return [
    pad('Mira Customer Register'),
    pad(`READ ONLY MIRROR — ledger source; Sheet edits are overwritten. Last synchronized ${now}`),
    Array(HEADERS.length).fill(''),
    HEADERS,
    ...rows
  ];
}

function safeCode(error) {
  const value = error?.code ?? error?.message;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value) ? value : 'CUSTOMER_SHEET_SYNC_FAILED';
}

function state(database) { return database.prepare('SELECT * FROM customer_sheet_mirror_state WHERE id=1').get() ?? null; }

function updateState(databasePath, values) {
  const database = openDatabase(databasePath);
  try { withImmediateTransaction(database, () => {
    database.prepare(`INSERT INTO customer_sheet_mirror_state
      (id,spreadsheet_id,folder_id_hash,source_hash,row_count,status,last_error_code,synced_at,updated_at)
      VALUES (1,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET spreadsheet_id=excluded.spreadsheet_id,folder_id_hash=excluded.folder_id_hash,
      source_hash=excluded.source_hash,row_count=excluded.row_count,status=excluded.status,last_error_code=excluded.last_error_code,
      synced_at=excluded.synced_at,updated_at=excluded.updated_at`).run(
      values.spreadsheetId ?? null, values.folderIdHash ?? null, values.sourceHash ?? null, values.rowCount ?? 0,
      values.status, values.errorCode ?? null, values.syncedAt ?? null, values.now
    );
    database.prepare(`INSERT INTO customer_sheet_sync_attempts
      (result,source_hash,row_count,spreadsheet_id_hash,error_code,actor,occurred_at) VALUES (?,?,?,?,?,?,?)`).run(
      values.result, values.sourceHash, values.rowCount, recordHash(values.spreadsheetId), values.errorCode ?? null, values.actor, values.now
    );
  }); } finally { database.close(); }
}

export async function syncCustomerSheetMirror({ databasePath, configuration, client, actor, now = new Date().toISOString() }) {
  if (!configuration?.enabled) return { status: 'NOT_CONFIGURED', rowCount: null, spreadsheetUrl: null };
  if (!client) throw new TypeError('Customer Sheet client is required.');
  const customers = customerRows(databasePath);
  const sourceHash = createHash('sha256').update(JSON.stringify(customers)).digest('hex');
  const folderIdHash = recordHash(configuration.folderId);
  const database = openDatabase(databasePath, { readOnly: true });
  let current;
  try { current = state(database); } finally { database.close(); }
  let spreadsheetId = current?.spreadsheet_id ?? null;
  try {
    const folder = await client.getMetadata(configuration.folderId);
    if (folder?.mimeType !== 'application/vnd.google-apps.folder') {
      throw Object.assign(new Error('CUSTOMER_SHEET_FOLDER_INVALID'), { code: 'CUSTOMER_SHEET_FOLDER_INVALID' });
    }
    if (!spreadsheetId) {
      const created = await client.createSpreadsheet({ title: configuration.spreadsheetTitle, sheetName: configuration.sheetName });
      spreadsheetId = created.id;
    }
    const metadata = await client.moveToFolder({ spreadsheetId, folderId: configuration.folderId });
    if (!metadata.parents.includes(configuration.folderId)) throw Object.assign(new Error('CUSTOMER_SHEET_FOLDER_MISMATCH'), { code: 'CUSTOMER_SHEET_FOLDER_MISMATCH' });
    if (current?.source_hash === sourceHash && current?.status === 'SYNCED' && current?.folder_id_hash === folderIdHash) {
      updateState(databasePath, { spreadsheetId, folderIdHash, sourceHash, rowCount: customers.length, status: 'SYNCED',
        result: 'UNCHANGED', syncedAt: current.synced_at, actor, now });
      return { status: 'UNCHANGED', rowCount: customers.length, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
    }
    const values = buildCustomerSheetValues(customers, now);
    const tab = `'${configuration.sheetName}'`;
    const lastRow = values.length;
    await client.updateValues({ spreadsheetId, range: `${tab}!A1:S${lastRow}`, values });
    if ((current?.row_count ?? 0) > customers.length) {
      await client.clearValues({ spreadsheetId, range: `${tab}!A${lastRow + 1}:S${(current.row_count ?? 0) + 4}` });
    }
    await client.format({ spreadsheetId, range: `${tab}!A1:S1`,
      format: { textFormat: { bold: true, fontSize: 14 }, backgroundColor: { red: 1, green: 1, blue: 1 } },
      fields: 'userEnteredFormat.textFormat,userEnteredFormat.backgroundColor' });
    await client.format({ spreadsheetId, range: `${tab}!A4:S4`,
      format: { textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, backgroundColor: { red: 0.09, green: 0.21, blue: 0.36 } },
      fields: 'userEnteredFormat.textFormat,userEnteredFormat.backgroundColor' });
    await client.freeze({ spreadsheetId, rows: 4, columns: 1 });
    await client.autoResize({ spreadsheetId, range: `${tab}!A:S` });
    updateState(databasePath, { spreadsheetId, folderIdHash, sourceHash, rowCount: customers.length, status: 'SYNCED',
      result: 'SUCCEEDED', syncedAt: now, actor, now });
    return { status: 'SYNCED', rowCount: customers.length, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
  } catch (error) {
    const errorCode = safeCode(error);
    updateState(databasePath, { spreadsheetId, folderIdHash, sourceHash, rowCount: customers.length, status: 'FAILED',
      result: 'FAILED', errorCode, syncedAt: current?.synced_at ?? null, actor, now });
    return { status: 'FAILED', rowCount: customers.length, errorCode, spreadsheetUrl: null };
  }
}
