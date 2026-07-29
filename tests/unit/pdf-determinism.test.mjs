import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePdfDeterminism } from '../../scripts/lib/quotation-renderer.mjs';

function syntheticPdf(second, id, checksum) {
  return Buffer.from(`%PDF-1.7\n/CreationDate(D:202607291510${second}+08'00')\ntrailer\n<</ID [ <${id}>\n<${id}> ]\n/DocChecksum /${checksum}\n>>\n%%EOF`, 'latin1');
}

test('PDF normalization removes variable LibreOffice timestamps, IDs, and checksums without changing length', () => {
  const first = syntheticPdf('45', '87AC4F0DF6AEAFC74A4F473345A3C32F', '0903407B421907C43EE84F8D08990173');
  const second = syntheticPdf('47', '2D5C91A0B06CDB4D8FC7D0B50F33CAE6', '90B89183DA21840BE5498A3BEE0661FC');
  const normalizedFirst = normalizePdfDeterminism(first);
  const normalizedSecond = normalizePdfDeterminism(second);
  assert.equal(normalizedFirst.length, first.length);
  assert.equal(normalizedSecond.length, second.length);
  assert.deepEqual(normalizedFirst, normalizedSecond);
  assert.match(normalizedFirst.toString('latin1'), /CreationDate\(D:19800101000000\+00'00'\)/);
});
