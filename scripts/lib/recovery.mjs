import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { backupDatabase } from '../backup-database.mjs';
import { checkDatabase } from '../check-database.mjs';
import { verifyLedgerEquivalence } from '../verify-ledger-equivalence.mjs';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { updateDocumentNumberStatusInTransaction } from './numbering.mjs';
import { canonicalJson } from './quotation-drafts.mjs';

export async function runRestoreDrill({ backupPath, targetPath }) {
  const source = path.resolve(backupPath), target = path.resolve(targetPath);
  if (source === target) throw new Error('RESTORE_TARGET_MUST_DIFFER');
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const restored = await backupDatabase({ sourcePath: source, destinationPath: target });
  const equivalence = verifyLedgerEquivalence(source, target);
  return { ...restored, logicalHash: equivalence.hash, tableCount: equivalence.tableCount };
}

const DEFINITIONS = [
  { type: 'quotation', entity: 'quotations', issuance: 'quotation_issuances', id: 'quotation_id' },
  { type: 'invoice', entity: 'invoices', issuance: 'invoice_issuances', id: 'invoice_id' },
  { type: 'credit_note', entity: 'credit_notes', issuance: 'credit_note_issuances', id: 'credit_note_id' }
];

export function recoverInterruptedIssuances({ databasePath, actor, staleBefore, now = new Date().toISOString() }) {
  if (typeof actor !== 'string' || !actor.trim()) throw new TypeError('actor is required.');
  if (new Date(staleBefore).toISOString() !== staleBefore || new Date(now).toISOString() !== now) throw new TypeError('Invalid recovery timestamp.');
  const database = openDatabase(databasePath);
  try {
    return withImmediateTransaction(database, () => {
      const recovered = [];
      for (const definition of DEFINITIONS) {
        const rows = database.prepare(`SELECT i.${definition.id} AS entity_id,i.document_number_id,i.attempt_count
          FROM ${definition.issuance} i JOIN ${definition.entity} e ON e.id=i.${definition.id}
          WHERE i.status='GENERATING' AND e.status='GENERATING' AND i.updated_at<=? ORDER BY i.${definition.id}`).all(staleBefore);
        for (const row of rows) {
          updateDocumentNumberStatusInTransaction(database, { allocationId: row.document_number_id, status: 'ISSUE_FAILED', entityId: row.entity_id, now });
          database.prepare(`UPDATE ${definition.entity} SET status='ISSUE_FAILED' WHERE id=?`).run(row.entity_id);
          database.prepare(`UPDATE ${definition.issuance} SET status='ISSUE_FAILED',last_error_code='INTERRUPTED_ISSUANCE',updated_at=? WHERE ${definition.id}=?`).run(now, row.entity_id);
          const attempts = `${definition.type}_issuance_attempts`;
          const idColumn = definition.id;
          database.prepare(`INSERT OR IGNORE INTO ${attempts} (${idColumn},attempt_number,result,error_code,actor,occurred_at)
            VALUES (?,?,'FAILED','INTERRUPTED_ISSUANCE',?,?)`).run(row.entity_id, row.attempt_count, actor.trim(), now);
          database.prepare(`INSERT INTO audit_events (timestamp,actor,action,entity_type,entity_id,result,details_json)
            VALUES (?,?,?,?,?,'FAIL',?)`).run(now, actor.trim(), `${definition.type}.interrupted_recovered`, definition.type, row.entity_id, canonicalJson({ errorCode: 'INTERRUPTED_ISSUANCE', numberPreserved: true }));
          recovered.push({ documentType: definition.type, entityId: row.entity_id, status: 'ISSUE_FAILED' });
        }
      }
      return recovered;
    });
  } finally { database.close(); }
}

export async function removeRestoreDrill(targetPath) { await rm(path.resolve(targetPath), { force: true }); }
