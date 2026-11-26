// Background organising: the second half of the update stream. After live capture saves something, the organiser
// runs over what is new (scope `new`: entries added or changed since each task last ran) in the order tag, file,
// link, hub, review. Each step is an ordinary run, listed in `skeinwise runs` and undoable. Layers are left to an
// explicit `skeinwise run layer`, because they cost a model call per entry.
//
// Background passes never pick an engine of their own. The local model is used without asking; an outside model only
// when `liveRemote` is on, and always within the monthly budget; with `none` the No-AI engine runs. If the model
// server doesn't answer, the pass stops and says so, and the next capture tries again.
//
// A pass reads the whole record into memory (RecordView), however little is new. A watching live runs each pass in a
// child process (`isolate`, src/live/pass-process.ts), so that memory goes when the pass ends, and live idles at what
// capture alone needs (the 150 MB budget of plan 7.2). Run in live's own process, the heap a pass grew stayed resident
// for a minute or more after it was over; run in a worker thread, V8 kept the worker's pages in a pool for the main
// thread to reuse.

import { type ChildProcess, execFileSync, fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.ts';
import { readNotes } from '../notes.ts';
import { createModel } from '../organiser/model.ts';
import { runTask, steps } from '../organiser/organise.ts';
import { RecordView } from '../organiser/record.ts';
import { failRun, lastMark, scopeEntries, type Task } from '../organiser/runs.ts';
import type { Store } from '../store/store.ts';
import { loadStatus, type Organised, writeStatus } from './capture.ts';

export type { Organised };

/** The tasks a background pass runs, in order. */
export const BACKGROUND_TASKS: readonly Task[] = ['tag', 'file', 'link', 'hub', 'review'];

export interface BackgroundOptions {
  store: Store;
  home: string;
  statusFile: string;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** A reason to wait instead of organising now, or null. Defaults to {@link busyReason}; `--once` passes none. */
  busy?: (() => string | null) | null;
  /** How long to wait before trying again when busy. */
  retryMs?: number;
  progress?: (line: string) => void;
  /** An unreadable live.json, moved aside (see {@link loadStatus}). */
  onWarning?: (line: string) => void;
  onDone?: (organised: Organised) => void;
  /**
   * Runs each pass in a child process with its own connection to the record, so the memory the pass used is given
   * back when it ends. The child uses the real clock, the global fetch and `env` as its environment, so a test that
   * hands in its own clock or fetch leaves this off.
   */
  isolate?: boolean;
}

/** What a pass did, before the status file is written. */
export type PassResult = Pick<Organised, 'entries' | 'runs' | 'notStarted' | 'waiting'>;

/** What the pass process sends back. */
export type PassReply = { type: 'progress'; line: string } | { type: 'done'; result: PassResult } | { type: 'error'; message: string };

// Next to this file: pass-process.ts when run from source, pass-process.js once built.
const PASS_PROCESS = fileURLToPath(new URL(`./pass-process${extname(fileURLToPath(import.meta.url))}`, import.meta.url));

/** Runs organiser passes one at a time; a trigger during a pass queues exactly one more. */
export class Background {
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private child: ChildProcess | null = null;
  private readonly options: BackgroundOptions;

  constructor(options: BackgroundOptions) {
    this.options = options;
  }

  /** Whether a pass is under way. */
  get active(): boolean {
    return this.running !== null;
  }

  /** Whether passes run in a child process (see {@link BackgroundOptions.isolate}). */
  get isolated(): boolean {
    return this.options.isolate === true;
  }

  trigger(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.loop();
  }

  /** Resolves when no pass is running or queued. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /**
   * Stops future passes. A run cut off mid-way is marked failed, so the next `skeinwise run` isn't blocked by it; what it
   * made was never saved, because a run saves in one transaction at its end.
   */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    // A pass in a child process finishes the step it is on and runs no more, as one in this process does.
    if (this.child?.connected) this.child.send({ type: 'stop' });
    if (this.running) {
      const { store } = this.options;
      const now = store.now();
      for (const row of store.db.prepare("SELECT id FROM runs WHERE status = 'running'").all() as { id: number }[]) {
        failRun(store.db, row.id, 'Stopped: skeinwise live was closed while this ran. Nothing was saved.', 0, 0, now);
      }
    }
  }

  private async loop(): Promise<void> {
    // `running` is cleared in the same step as the last `again` check: cleared a step later (a .finally on the
    // promise), a trigger arriving in between found a pass "running", set `again`, and was never run.
    try {
      do {
        this.again = false;
        const organised = await this.pass();
        this.options.onDone?.(organised);
      } while (this.again && !this.stopped);
    } finally {
      this.running = null;
    }
  }

  /** One pass over what is new. Never throws: a failure is reported in the result and the status file. */
  async pass(): Promise<Organised> {
    const { store, home } = this.options;
    const organised: Organised = { at: store.now(), entries: 0, runs: [] };
    const finish = () => {
      organised.at = store.now();
      // A pass that found nothing to do leaves the last useful line ("organised 41 new entries") in place.
      const idle = !organised.runs.length && !organised.error && !organised.waiting && !organised.notStarted;
      const status = loadStatus(this.options.statusFile, this.options.onWarning ?? (() => {}));
      if (!idle || !status.organised) writeStatus(this.options.statusFile, { ...status, organised });
      return organised;
    };

    const busy = this.options.busy === undefined ? busyReason : this.options.busy;
    const reason = busy?.() ?? null;
    if (reason) {
      organised.waiting = reason;
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.trigger(), this.options.retryMs ?? 60_000);
      return finish();
    }

    try {
      Object.assign(organised, this.options.isolate ? await this.inChild() : await organiseNew(store, home, { ...this.options, stopped: () => this.stopped }));
    } catch (err) {
      organised.error = (err as Error).message;
    }
    return finish();
  }

  /** One pass in a child process; resolves with what it did, or rejects with the error that stopped it. */
  private inChild(): Promise<PassResult> {
    const { home, env } = this.options;
    return new Promise((done, fail) => {
      // Node's own flags carry over, less --input-type, which Node refuses for a script started from a file.
      const execArgv = process.execArgv.filter((arg) => !arg.startsWith('--input-type'));
      const child = fork(PASS_PROCESS, [], { env, execArgv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced' });
      this.child = child;
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
      let result: PassResult | null = null;
      let error: string | null = null;
      child.on('message', (reply: PassReply) => {
        if (reply.type === 'progress') this.options.progress?.(reply.line);
        else if (reply.type === 'done') result = reply.result;
        else error = reply.message;
      });
      child.on('error', (err) => {
        this.child = null;
        fail(err);
      });
      child.on('close', (code, signal) => {
        this.child = null;
        if (result) done(result);
        else if (error !== null) fail(new Error(error));
        else fail(new Error(`The background pass stopped (${signal ?? `exit ${code}`})${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : '.'}`));
      });
      child.send({ type: 'start', home });
      if (this.stopped) child.send({ type: 'stop' });
    });
  }
}

/**
 * Organises what is new since each background task last ran, in this process: the body of a pass, shared by
 * {@link Background} and the pass process. Throws what stops it; the caller reports it.
 */
export async function organiseNew(
  store: Store,
  home: string,
  deps: Pick<BackgroundOptions, 'fetch' | 'env' | 'progress'> & { stopped: () => boolean },
): Promise<PassResult> {
  const result: PassResult = { entries: 0, runs: [] };
  const config = loadConfig(home);
  if (config.engine === 'remote' && !config.liveRemote) {
    result.waiting = 'the outside model only organises in the background with: skeinwise config liveRemote on';
    return result;
  }
  const client = config.engine === 'none' ? undefined : createModel(config, config.engine, { fetch: deps.fetch, env: deps.env, home });
  readNotes(store, home);
  // The whole record in memory, built only once a step will use it: a record never organised needs none (L6).
  let record: RecordView | undefined;
  const notStarted = new Set<string>();
  for (const step of steps(store, 'all').filter((s) => BACKGROUND_TASKS.includes(s.task))) {
    const schemaId = step.schema?.id ?? null;
    // A task that has never run over the whole record is left to `skeinwise run all`: its first pass covers
    // everything, which is the user's call to make, not a background one.
    if (lastMark(store.db, step.task, schemaId) === null) {
      notStarted.add(step.task);
      continue;
    }
    record ??= new RecordView(store);
    const scoped = scopeEntries(store.db, record, { kind: 'new' }, step.task, schemaId);
    if (!scoped.length) continue;
    if (deps.stopped()) break;
    const run = await runTask(store, record, {
      task: step.task,
      ...(step.schema ? { schema: step.schema } : {}),
      scope: { kind: 'new' },
      engine: config.engine,
      ...(client ? { client } : {}),
      // Small passes over new entries need no approval with the local model; an outside model keeps the limit.
      yes: config.engine !== 'remote',
      budget: config.budget,
      progress: deps.progress ?? (() => {}),
    });
    result.runs.push(run.id);
    result.entries = Math.max(result.entries, scoped.length);
  }
  if (notStarted.size) result.notStarted = [...notStarted];
  return result;
}

/** Why organising should wait right now: the computer is busy, or it runs on a low battery. Null when it needn't. */
export function busyReason(): string | null {
  const cores = cpus().length;
  const load = loadavg()[0]!;
  if (cores && load > cores * 0.85) return `the computer is busy (load ${load.toFixed(1)} on ${cores} cores)`;
  const battery = readBattery();
  if (battery && battery.discharging && battery.percent < 20) return `the battery is at ${battery.percent}%`;
  return null;
}

/** macOS's pmset, by its absolute path: a `pmset` placed earlier on PATH is never run (L15). */
export const PMSET = '/usr/bin/pmset';

/** Runs a program and returns what it printed (tests pass a fake). */
export type Exec = (file: string, args: string[], options: { encoding: 'utf8'; timeout: number; env: Record<string, string> }) => string;

const execProgram: Exec = (file, args, options) => execFileSync(file, args, options);

/** The battery's charge and whether it is discharging, on macOS and Linux; null without a battery or elsewhere. */
export function readBattery(platform: NodeJS.Platform = process.platform, exec: Exec = execProgram): { percent: number; discharging: boolean } | null {
  if (platform === 'darwin') {
    let out: string;
    try {
      // pmset needs nothing from the environment, so it gets none of it.
      out = exec(PMSET, ['-g', 'batt'], { encoding: 'utf8', timeout: 2000, env: {} });
    } catch {
      return null;
    }
    return parsePmset(out);
  }
  if (platform === 'linux') {
    for (const name of ['BAT0', 'BAT1']) {
      const dir = `/sys/class/power_supply/${name}`;
      if (!existsSync(`${dir}/capacity`)) continue;
      const percent = Number(readFileSync(`${dir}/capacity`, 'utf8').trim());
      const state = existsSync(`${dir}/status`) ? readFileSync(`${dir}/status`, 'utf8').trim() : '';
      return Number.isFinite(percent) ? { percent, discharging: state === 'Discharging' } : null;
    }
  }
  return null;
}

/** Reads `pmset -g batt`, e.g. "-InternalBattery-0 (id=1)	45%; discharging; 3:10 remaining". */
export function parsePmset(out: string): { percent: number; discharging: boolean } | null {
  const m = /(\d{1,3})%;\s*([a-zA-Z ]+?);/.exec(out);
  return m ? { percent: Number(m[1]), discharging: m[2]!.trim() === 'discharging' } : null;
}
