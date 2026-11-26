// Runs a target in a worker thread and watches it from here: an input still running past `hangMs` is a hang, and a
// worker that dies (an exit, a heap past `heapMb`, an uncaught error) is a crash. Either way the input it was on is a
// finding, and a new worker carries on from the next input, so one bad input doesn't end the run.

import { Worker } from 'node:worker_threads';
import type { Finding, FindingKind } from './engine.ts';
import { targetNamed } from './targets.ts';
import type { Job } from './worker.ts';

export interface PoolOptions {
  seed: number;
  /** The first input (default 0). Inputs start..iterations-1 run, until the deadline (Date.now()) passes. */
  start?: number;
  iterations: number;
  deadline: number;
  /** The target's own folder: its input file is written there, and it may write nowhere else. */
  folder: string;
  /** Past this an input is slow, a finding; the worker carries on. */
  budgetMs: number;
  /** Past this an input is hung: its worker is stopped. */
  hangMs: number;
  /** The worker's heap limit. */
  heapMb: number;
}

export interface PoolResult {
  runs: number;
  /** The inputs the target refused, as it promises to, in the workers that lived to say (not one that hung or died). */
  refused: number;
  ms: number;
  findings: Finding[];
}

const WORKER = new URL('./worker.ts', import.meta.url);

interface Round {
  /** The worker finished its inputs or the deadline came; otherwise it stopped on input `at`. */
  finished: boolean;
  runs: number;
  refused: number;
  at: number;
}

function round(name: string, owner: string, o: PoolOptions, start: number, findings: Finding[]): Promise<Round> {
  const progress = new Int32Array(new SharedArrayBuffer(8));
  progress[0] = -1;
  const job: Job = { name, seed: o.seed, start, iterations: o.iterations, deadline: o.deadline, folder: o.folder, budgetMs: o.budgetMs, progress };
  const worker = new Worker(WORKER, { workerData: job, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: o.heapMb } });
  return new Promise((resolve) => {
    let done: { refused: number } | undefined;
    let stopped: { kind: FindingKind; error: string; at: number } | undefined;
    let seen = -1;
    let since = Date.now();
    const stop = (kind: FindingKind, error: string) => {
      if (stopped || done) return;
      const at = Atomics.load(progress, 0);
      stopped = { kind, error, at };
      findings.push({ target: name, owner, kind, seed: o.seed, iteration: at, ms: Date.now() - since, error });
    };
    const watch = setInterval(
      () => {
        const at = Atomics.load(progress, 0);
        if (at !== seen) {
          seen = at;
          since = Date.now();
        } else if (at >= 0 && Date.now() - since > o.hangMs) {
          stop('hang', `input ${at} was still running after ${o.hangMs} ms`);
          void worker.terminate();
        }
      },
      Math.max(10, Math.min(100, o.hangMs / 4)),
    );
    worker.on('message', (m: { finding?: Finding; done?: { refused: number } }) => {
      if (m.finding) findings.push(m.finding);
      if (m.done) done = m.done;
    });
    worker.on('error', (e) => stop('crash', e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
    worker.on('exit', (code) => {
      clearInterval(watch);
      if (!done && !stopped) stop('crash', `the worker exited with code ${code}`);
      const runs = Atomics.load(progress, 1);
      const refused = done?.refused ?? 0;
      // A worker that died outside an input (it failed to load) would die again: stop there.
      if (done || !stopped || stopped.at < 0) resolve({ finished: true, runs, refused, at: -1 });
      else resolve({ finished: false, runs, refused, at: stopped.at });
    });
  });
}

/** Fuzzes one target, in as many workers as hangs and crashes take. */
export async function fuzzTarget(name: string, o: PoolOptions): Promise<PoolResult> {
  const { owner } = targetNamed(name);
  const started = performance.now();
  const findings: Finding[] = [];
  let runs = 0;
  let refused = 0;
  let start = o.start ?? 0;
  while (start < o.iterations && Date.now() < o.deadline) {
    const r = await round(name, owner, o, start, findings);
    runs += r.runs;
    refused += r.refused;
    if (r.finished) break;
    start = r.at + 1;
  }
  return { runs, refused, ms: performance.now() - started, findings };
}
