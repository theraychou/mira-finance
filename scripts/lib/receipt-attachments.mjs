import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

const definitions = [
  { mimeType: 'application/pdf', extension: '.pdf', matches: (b) => b.subarray(0, 5).toString('ascii') === '%PDF-' },
  { mimeType: 'image/png', extension: '.png', matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) },
  { mimeType: 'image/jpeg', extension: '.jpg', matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: 'image/webp', extension: '.webp', matches: (b) => b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' }
];

function safeSourcePath(sourcePath, intakeRoot) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw new TypeError('Attachment path must be absolute.');
  const root = path.resolve(intakeRoot);
  const candidate = path.resolve(sourcePath);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) throw new Error('ATTACHMENT_OUTSIDE_APPROVED_INBOX');
  return candidate;
}

export function detectReceiptMime(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('Receipt content must be a Buffer.');
  return definitions.find((item) => item.matches(buffer)) ?? null;
}

export async function inspectReceiptAttachment({
  sourcePath,
  intakeRoot,
  declaredMimeType = null,
  maxBytes = MAX_RECEIPT_BYTES
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer.');
  const resolved = safeSourcePath(sourcePath, intakeRoot);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('ATTACHMENT_NOT_REGULAR_FILE');
  if (metadata.size < 1) throw new Error('ATTACHMENT_EMPTY');
  if (metadata.size > maxBytes) throw new Error('ATTACHMENT_TOO_LARGE');
  const buffer = await readFile(resolved);
  const detected = detectReceiptMime(buffer);
  if (!detected) throw new Error('ATTACHMENT_TYPE_UNSUPPORTED');
  if (declaredMimeType && declaredMimeType !== detected.mimeType) throw new Error('ATTACHMENT_MIME_MISMATCH');
  return Object.freeze({
    sourcePath: resolved,
    sourceFilename: path.basename(resolved).slice(0, 255),
    mimeType: detected.mimeType,
    extension: detected.extension,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex')
  });
}

export async function preserveReceiptAttachment({ inspected, storageRoot, receivedDate }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate ?? '')) throw new TypeError('receivedDate must use YYYY-MM-DD.');
  const relativePath = path.join(receivedDate.slice(0, 4), receivedDate.slice(5, 7), `${inspected.sha256}${inspected.extension}`);
  const destination = path.resolve(storageRoot, relativePath);
  const root = path.resolve(storageRoot);
  if (!destination.startsWith(`${root}${path.sep}`)) throw new Error('RECEIPT_STORAGE_PATH_INVALID');
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await copyFile(inspected.sourcePath, destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readFile(destination);
    if (createHash('sha256').update(existing).digest('hex') !== inspected.sha256) throw new Error('RECEIPT_STORAGE_COLLISION');
  }
  return { relativePath: relativePath.replaceAll(path.sep, '/'), destination };
}

