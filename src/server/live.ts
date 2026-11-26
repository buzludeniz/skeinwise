// Record live in the app: the same update stream as `skeinwise live` (src/live/run.ts), run inside `skeinwise serve`
// while the app menu's switch is on. The two status lines come from the stream's own status file.

import { join } from 'node:path';
import { readStatus, statusLines } from '../live/capture.ts';
import { type LiveRun, startLive } from '../live/run.ts';
import type { Store } from '../store/store.ts';

export interface LiveState {
  /** Whether the stream runs in this server now. */
  on: boolean;
  /** The two lines under Record live, or null when the stream has never run and the switch is off. */
  lines: [string, string] | null;
  /** Why the stream couldn't start or its status couldn't be read. */
  error: string | null;
}

export interface LiveDeps {
  /** The user's home folder, where agent histories and Downloads are found (SKEINWISE_SCAN_ROOT in tests). */
  userHome: string;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class AppLive {
  private run: LiveRun | null = null;
  private error: string | null = null;
  private wanted = false;
  private readonly store: Store;
  private readonly home: string;
  private readonly deps: LiveDeps;

  constructor(store: Store, home: string, deps: LiveDeps) {
    this.store = store;
    this.home = home;
    this.deps = deps;
  }

  /**
   * Turns the stream on or off. Starting catches up on everything changed since the last pass, which can take a
   * while on a first run, so it starts on the next turn of the event loop and the settings request answers first.
   */
  set(on: boolean): void {
    this.wanted = on;
    if (!on) {
      this.run?.stop();
      this.run = null;
      return;
    }
    if (this.run) return;
    setImmediate(() => {
      if (!this.wanted || this.run) return;
      try {
        this.run = startLive(this.store, this.home, {
          userHome: this.deps.userHome,
          ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
          ...(this.deps.env ? { env: this.deps.env } : {}),
        });
        this.error = null;
      } catch (error) {
        this.error = `Live capture couldn't start: ${text(error)}`;
      }
    });
  }

  state(): LiveState {
    const on = this.run !== null;
    try {
      const status = readStatus(join(this.home, 'live.json'));
      const ran = status.lastPassAt !== null || status.lastSavedAt !== null;
      return { on, lines: on || ran ? statusLines(status) : null, error: this.error };
    } catch (error) {
      return { on, lines: null, error: `live.json in the record folder can't be read: ${text(error)}` };
    }
  }

  stop(): void {
    this.set(false);
  }
}
