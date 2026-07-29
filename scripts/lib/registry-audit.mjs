import { createHash } from 'node:crypto';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function recordHash(record) {
  if (record === null || record === undefined) return null;
  return createHash('sha256').update(JSON.stringify(stable(record))).digest('hex');
}

export function appendRegistryAudit(database, {
  timestamp,
  actor,
  action,
  entityType,
  entityId,
  before,
  after,
  result = 'PASS',
  changedFields = []
}) {
  if (typeof actor !== 'string' || actor.trim().length === 0) throw new TypeError('actor is required.');
  database.prepare(`
    INSERT INTO audit_events (
      timestamp, actor, action, entity_type, entity_id,
      before_hash, after_hash, result, details_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    timestamp,
    actor,
    action,
    entityType,
    entityId ?? null,
    recordHash(before),
    recordHash(after),
    result,
    JSON.stringify({ changedFields: [...changedFields].sort() })
  );
}
