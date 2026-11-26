// One fuzz worker: it runs one target's inputs with the write guard on, posts each finding as it comes, and marks the
// input it is on in shared memory, so pool.ts can tell a hang from slow progress and name the input that crashed it.

import { parentPort, workerData } from 'node:worker_threads';
import { loop, type LoopOptions } from './engine.ts';
import { installWriteGuard } from './guard.ts';
import { targetNamed } from './targets.ts';

export type Job = Omit<LoopOptions, 'onFinding'> & { name: string; progress: Int32Array };

const port = parentPort;
if (!port) throw new Error('worker.ts runs only as a worker: see pool.ts');
installWriteGuard();
const job = workerData as Job;
// Something to wait on while an input's promise is pending, so one that never settles is still running when pool.ts
// looks (a hang), rather than letting the worker exit with nothing left to do.
const awake = setInterval(() => {}, 2 ** 30);
const done = await loop(targetNamed(job.name), { ...job, onFinding: (finding) => port.postMessage({ finding }) });
clearInterval(awake);
port.postMessage({ done });
