import { openDatabase, withImmediateTransaction } from './database.mjs';

const documentTypes = new Set(['quotation', 'invoice', 'claim', 'credit_note']);
const transitions = {
  ALLOCATED: new Set(['GENERATING', 'ISSUE_FAILED', 'CANCELLED']),
  GENERATING: new Set(['ISSUED', 'ISSUE_FAILED', 'CANCELLED']),
  ISSUE_FAILED: new Set(['GENERATING', 'CANCELLED']),
  ISSUED: new Set(['CANCELLED']),
  CANCELLED: new Set()
};

function assertDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError('sequenceDate must use YYYY-MM-DD.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError('sequenceDate must be a real calendar date.');
  }
}

function assertInitials(value) {
  if (!/^[A-Z0-9]{1,8}$/.test(value)) throw new TypeError('clientInitials must be 1-8 uppercase letters or digits.');
}

export function formatDocumentNumber({ sequenceDate, sequenceValue, clientInitials }) {
  assertDate(sequenceDate);
  assertInitials(clientInitials);
  if (!Number.isInteger(sequenceValue) || sequenceValue < 1001) throw new TypeError('sequenceValue must be an integer of at least 1001.');
  return `${sequenceDate.slice(2).replaceAll('-', '')}${String(sequenceValue).padStart(4, '0')}-${clientInitials}`;
}

export function allocateDocumentNumberInTransaction(database, {
  documentType, sequenceDate, clientInitials, now = new Date().toISOString()
}) {
  if (!documentTypes.has(documentType)) throw new TypeError('Unsupported document type.');
  assertDate(sequenceDate);
  assertInitials(clientInitials);
  database.prepare(`
    INSERT INTO number_sequences (document_type, sequence_date, next_value, updated_at)
    VALUES (?, ?, 1001, ?)
    ON CONFLICT (document_type, sequence_date) DO NOTHING
  `).run(documentType, sequenceDate, now);
  const sequence = database.prepare(`
    SELECT next_value FROM number_sequences WHERE document_type = ? AND sequence_date = ?
  `).get(documentType, sequenceDate);
  const globalNext = database.prepare(`
    SELECT COALESCE(MAX(sequence_value) + 1, 1001) AS next_value
    FROM document_numbers WHERE sequence_date = ?
  `).get(sequenceDate).next_value;
  const sequenceValue = Math.max(sequence.next_value, globalNext);
  const documentNumber = formatDocumentNumber({
    sequenceDate,
    sequenceValue,
    clientInitials
  });
  const result = database.prepare(`
    INSERT INTO document_numbers (
      document_type, sequence_date, sequence_value, client_initials,
      document_number, status, allocated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'ALLOCATED', ?, ?)
  `).run(documentType, sequenceDate, sequenceValue, clientInitials, documentNumber, now, now);
  database.prepare(`
    UPDATE number_sequences SET next_value = ?, updated_at = ?
    WHERE document_type = ? AND sequence_date = ? AND next_value = ?
  `).run(sequenceValue + 1, now, documentType, sequenceDate, sequence.next_value);
  return {
    id: Number(result.lastInsertRowid),
    documentType,
    documentNumber,
    sequenceValue,
    status: 'ALLOCATED'
  };
}

export function allocateDocumentNumber({ databasePath, documentType, sequenceDate, clientInitials, now = new Date().toISOString() }) {
  if (!documentTypes.has(documentType)) throw new TypeError('Unsupported document type.');
  assertDate(sequenceDate);
  assertInitials(clientInitials);
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => allocateDocumentNumberInTransaction(database, {
      documentType, sequenceDate, clientInitials, now
    }));
  } finally {
    database.close();
  }
}

export function updateDocumentNumberStatusInTransaction(database, { allocationId, status, entityId = null, now = new Date().toISOString() }) {
  if (!Number.isInteger(allocationId) || allocationId < 1) throw new TypeError('allocationId must be a positive integer.');
  if (!Object.hasOwn(transitions, status)) throw new TypeError('Unsupported allocation status.');
  const current = database.prepare('SELECT * FROM document_numbers WHERE id = ?').get(allocationId);
  if (!current) throw new Error('Document-number allocation was not found.');
  if (!transitions[current.status].has(status)) throw new Error(`Invalid number status transition: ${current.status} -> ${status}.`);
  database.prepare('UPDATE document_numbers SET status = ?, entity_id = COALESCE(?, entity_id), updated_at = ? WHERE id = ?')
    .run(status, entityId, now, allocationId);
  return { ...current, status, entity_id: entityId ?? current.entity_id, updated_at: now };
}
export function updateDocumentNumberStatus({ databasePath, allocationId, status, entityId = null, now = new Date().toISOString() }) {
  if (!Number.isInteger(allocationId) || allocationId < 1) throw new TypeError('allocationId must be a positive integer.');
  if (!Object.hasOwn(transitions, status)) throw new TypeError('Unsupported allocation status.');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => updateDocumentNumberStatusInTransaction(database, {
      allocationId, status, entityId, now
    }));
  } finally {
    database.close();
  }
}
