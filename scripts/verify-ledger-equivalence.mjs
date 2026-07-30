#!/usr/bin/env node
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './lib/database.mjs';
import { canonicalJson } from './lib/quotation-drafts.mjs';

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function logicalLedgerHash(databasePath) {
  const database = openDatabase(databasePath, { readOnly: true });
  try {
    const hash = createHash('sha256');
    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => row.name);
    for (const table of tables) {
      if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new Error('Unexpected ledger table name.');
      const columns = database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name);
      const rows = database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
      hash.update(canonicalJson({ table, columns, rows }));
    }
    return { hash: hash.digest('hex'), tableCount: tables.length };
  } finally {
    database.close();
  }
}

export function verifyLedgerEquivalence(leftPath, rightPath) {
  const left = logicalLedgerHash(leftPath);
  const right = logicalLedgerHash(rightPath);
  if (left.hash !== right.hash || left.tableCount !== right.tableCount) throw new Error('LEDGERS_DIFFER');
  return { hash: left.hash, tableCount: left.tableCount };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyLedgerEquivalence(value('--left'), value('--right'));
    console.log(`PASS ledgers are logically equivalent across ${result.tableCount} tables`);
  } catch (error) {
    console.error(`FAIL ledger equivalence check failed (${error?.message ?? 'LEDGER_EQUIVALENCE_FAILED'})`);
    process.exitCode = 1;
  }
}
