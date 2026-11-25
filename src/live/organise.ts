// Background organising: the second half of the update stream. After live capture saves something, the organiser
// runs over what is new (scope `new`: entries added or changed since each task last ran) in the order tag, file,
// link, hub, review. Each step is an ordinary run, listed in `skeinwise runs` and undoable. Layers are left to an
// explicit `skeinwise run layer`, because they cost a model call per entry.
//
// Background passes never pick an engine of their own. The local model is used without asking; an outside model only
// when `liveRemote` is on, and always within the monthly budget; with `none` the No-AI engine runs. If the model
// server doesn't answer, the pass stops and says so, and the next capture tries again.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
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
}

/** Runs organiser passes one at a time; a trigger during a pass queues exactly one more. */
export class Background {
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly options: BackgroundOptions;

  constructor(options: BackgroundOptions) {
    this.options = options;
  }

  /** Whether a pass is under way. */
  get active(): boolean {
    return this.running !== null;
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
      const config = loadConfig(home);
      if (config.engine === 'remote' && !config.liveRemote) {
        organised.waiting = 'the outside model only organises in the background with: skeinwise config liveRemote on';
        return finish();
      }
      const client = config.engine === 'none' ? undefined : createModel(config, config.engine, { fetch: this.options.fetch, env: this.options.env });
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
        if (this.stopped) break;
        const run = await runTask(store, record, {
          task: step.task,
          ...(step.schema ? { schema: step.schema } : {}),
          scope: { kind: 'new' },
          engine: config.engine,
          ...(client ? { client } : {}),
          // Small passes over new entries need no approval with the local model; an outside model keeps the limit.
          yes: config.engine !== 'remote',
          budget: config.budget,
          progress: this.options.progress ?? (() => {}),
        });
        organised.runs.push(run.id);
        organised.entries = Math.max(organised.entries, scoped.length);
      }
      if (notStarted.size) organised.notStarted = [...notStarted];
    } catch (err) {
      organised.error = (err as Error).message;
    }
    return finish();
  }
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
