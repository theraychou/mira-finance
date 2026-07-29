import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, withImmediateTransaction } from './database.mjs';
import { repositoryRoot } from '../validate-config.mjs';

export const defaultMigrationsDirectory = path.join(repositoryRoot, 'data', 'migrations');

function migrationVersion(filename) {
  const match = /^(\d+)_.*\.up\.sql$/.exec(filename);
  return match ? Number(match[1]) : undefined;
}

function ensureMigrationTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
}

export async function currentMigrationVersion(databasePath) {
  const database = openDatabase(databasePath);
  try {
    ensureMigrationTable(database);
    return database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
  } finally {
    database.close();
  }
}
export async function migrateUp({ databasePath, migrationsDirectory = defaultMigrationsDirectory, now = () => new Date().toISOString() } = {}) {
  const files = (await readdir(migrationsDirectory))
    .filter((name) => migrationVersion(name) !== undefined)
    .sort((left, right) => migrationVersion(left) - migrationVersion(right));
  const database = openDatabase(databasePath);
  try {
    ensureMigrationTable(database);
    const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
    const completed = [];
    for (const filename of files) {
      const version = migrationVersion(filename);
      if (applied.has(version)) continue;
      const sql = await readFile(path.join(migrationsDirectory, filename), 'utf8');
      withImmediateTransaction(database, () => {
        database.exec(sql);
        database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(version, filename, now());
      });
      completed.push(version);
    }
    return { version: database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version, applied: completed };
  } finally {
    database.close();
  }
}

export async function migrateDown({ databasePath, migrationsDirectory = defaultMigrationsDirectory } = {}) {
  const database = openDatabase(databasePath);
  try {
    ensureMigrationTable(database);
    const latest = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
    if (!latest) return { version: 0, reverted: [] };
    const downName = latest.name.replace(/\.up\.sql$/, '.down.sql');
    const sql = await readFile(path.join(migrationsDirectory, downName), 'utf8');
    withImmediateTransaction(database, () => {
      database.exec(sql);
      database.prepare('DELETE FROM schema_migrations WHERE version = ?').run(latest.version);
    });
    const version = database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version;
    return { version, reverted: [latest.version] };
  } finally {
    database.close();
  }
}
