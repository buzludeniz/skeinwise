// The worker thread behind readImportsInWorker: reads one path off the main thread and posts the batches back.

import { parentPort, workerData } from 'node:worker_threads';
import { UnsafeFileError } from '../fsafe.ts';
import { readImports, type ImportOptions } from './detect.ts';

const port = parentPort;
if (!port) throw new Error('read-worker.ts runs only as a worker thread');
const { path, options } = workerData as { path: string; options: ImportOptions };

try {
  const batches = readImports(path, { ...options, onWarning: (message) => port.postMessage({ type: 'warning', message }) });
  port.postMessage({ type: 'done', batches });
} catch (error) {
  if (error instanceof UnsafeFileError) {
    port.postMessage({ type: 'error', message: error.message, path: error.path, reason: error.reason });
  } else {
    port.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}
