import { parentPort, workerData } from 'node:worker_threads';
import { allocateDocumentNumber } from '../../scripts/lib/numbering.mjs';

try {
  parentPort.postMessage({ ok: true, allocation: allocateDocumentNumber(workerData) });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
}
