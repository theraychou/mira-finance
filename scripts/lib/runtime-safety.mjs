import { appendFile, chmod, lstat, mkdir, readdir, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';

function safeCode(value, fallback) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value) ? value : fallback;
}

export async function diskCapacity(targetPath) {
  const stats = await statfs(path.resolve(targetPath));
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  return { freeBytes, totalBytes, freeRatio: totalBytes > 0 ? freeBytes / totalBytes : 0 };
}

export async function assertDiskSpace({ targetPath, requiredBytes = 0, minimumFreeBytes = 256 * 1024 * 1024, minimumFreeRatio = 0.05 }) {
  const capacity = await diskCapacity(targetPath);
  if (capacity.freeBytes - requiredBytes < minimumFreeBytes || capacity.freeRatio < minimumFreeRatio) {
    const error = new Error('DISK_SPACE_PROTECTION_TRIGGERED');
    error.code = 'DISK_SPACE_PROTECTION_TRIGGERED';
    throw error;
  }
  return capacity;
}

export async function recordFailureAlert({ root, code, operation, entityType = null, entityId = null, now = new Date().toISOString() }) {
  const logs = path.resolve(root, 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const file = path.join(logs, 'alerts.jsonl');
  const entry = {
    schemaVersion: 1, timestamp: now, severity: 'ERROR',
    code: safeCode(code, 'OPERATION_FAILED'), operation: safeCode(operation, 'UNKNOWN_OPERATION'),
    entityType: typeof entityType === 'string' && /^[a-z_]+$/.test(entityType) ? entityType : null,
    entityId: Number.isSafeInteger(entityId) && entityId > 0 ? entityId : null
  };
  await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(file, 0o600);
  return entry;
}

export async function auditPrivatePermissions(root) {
  const exceptions = [], symlinks = [];
  const rootMetadata = await lstat(root);
  if ((rootMetadata.mode & 0o077) !== 0) exceptions.push('(workspace-root)');
  if (rootMetadata.isSymbolicLink()) symlinks.push('(workspace-root)');
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const candidate = path.join(directory, entry.name);
      const metadata = await lstat(candidate);
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      if ((metadata.mode & 0o077) !== 0) exceptions.push(relative);
      if (metadata.isSymbolicLink()) symlinks.push(relative);
      else if (metadata.isDirectory()) await walk(candidate);
    }
  }
  await walk(root);
  return { ok: exceptions.length === 0 && symlinks.length === 0, exceptions, symlinks };
}

export async function rotateJsonlLogs({ root, maximumBytes = 5 * 1024 * 1024, retained = 5 }) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1024 || !Number.isSafeInteger(retained) || retained < 1 || retained > 20) {
    throw new TypeError('Invalid log rotation policy.');
  }
  const logs = path.resolve(root, 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  const rotated = [];
  for (const entry of await readdir(logs, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const current = path.join(logs, entry.name);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink() || metadata.size <= maximumBytes) continue;
    await rm(`${current}.${retained}`, { force: true });
    for (let index = retained - 1; index >= 1; index -= 1) {
      try { await rename(`${current}.${index}`, `${current}.${index + 1}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await rename(current, `${current}.1`);
    await chmod(`${current}.1`, 0o600);
    rotated.push(entry.name);
  }
  return { rotated };
}

export async function cleanupTemporaryFiles({ root, olderThanMs = 60 * 60 * 1000, now = Date.now() }) {
  const approved = [path.resolve(root, 'generated'), path.resolve(root, 'data')];
  const removed = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) continue;
      const temporary = entry.name.startsWith('.staging-') || entry.name.startsWith('.lo-profile-') || entry.name.includes('.tmp-');
      if (temporary && now - metadata.mtimeMs >= olderThanMs) {
        await rm(candidate, { recursive: metadata.isDirectory(), force: true });
        removed.push(path.relative(root, candidate).split(path.sep).join('/'));
      } else if (entry.isDirectory()) await walk(candidate);
    }
  }
  for (const directory of approved) await walk(directory);
  return { removed };
}
