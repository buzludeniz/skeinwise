// `skeinwise live`: the update stream from the command line. Capture imports what changes; after each save the
// background organiser runs over what is new. Connectors are off in v1.0 (Deniz, Nov 25): they ship in v1.1 behind
// their own consent screen, so live pulls from a connected service only when its caller passes `poll`.

import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import type { PollReport } from '../connectors/poll.ts';
import type { Store } from '../store/store.ts';
import { defaultTargets, LiveCapture, type LiveStatus, loadStatus, statusLines } from './capture.ts';
import { Background } from './organise.ts';

export interface LiveOptions {
  /** Catch up once and stop, instead of watching. */
  once?: boolean;
  /** The user's home folder, where agent histories and Downloads are found. */
  userHome?: string;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Overrides the busy and battery check (tests; `--once` turns it off). */
  busy?: (() => string | null) | null;
  /** After every capture that saved something. */
  onSaved?: (status: LiveStatus) => void;
  /** After every background pass. */
  onOrganised?: (status: LiveStatus) => void;
  progress?: (line: string) => void;
  /** Something live carries on past (an unreadable live.json, a capture pass that failed). Defaults to `progress`. */
  onWarning?: (line: string) => void;
  /** After every connector pull that read something or failed: one line per connection, or the error. */
  onPulled?: (lines: string[]) => void;
  /** Seconds between connector checks (default 60). Each connection keeps its own pace; most checks pull nothing. */
  pollSeconds?: number;
  /**
   * Pulls from the connected services. Without it live pulls nothing and never reads connections.json: connectors
   * are off in v1.0, and both callers (`skeinwise live` and the web app's Record live) leave it out.
   */
  poll?: (store: Store, home: string) => Promise<PollReport[]>;
  /**
   * Runs each background pass in a child process, so live idles at what capture needs (see src/live/organise.ts).
   * Defaults to on while watching with the real fetch; off with `once` (the process ends with the pass) and when the
   * caller hands in its own fetch, which a child process can't use.
   */
  isolate?: boolean;
}

export interface LiveRun {
  capture: LiveCapture;
  /** Null when `liveOrganise` is off. */
  background: Background | null;
  /** Whatever was found on start-up (everything changed since the last pass). */
  first: LiveStatus;
  /** The start-up connector pull; with `once`, await it before `background.idle()`. */
  pulled: Promise<void>;
  /**
   * Stops watching and organising, and resolves once the pass under way has ended (see Background.stop). A run cut off
   * mid-way is marked failed.
   */
  stop: () => Promise<void>;
}

/**
 * Catches up on what changed since the last pass, starts a background pass when anything is new, and (unless `once`)
 * keeps watching. With `once`, await `background.idle()` before closing the store.
 */
export function startLive(store: Store, home: string, options: LiveOptions = {}): LiveRun {
  const config = loadConfig(home);
  const statusFile = join(home, 'live.json');
  const warn = options.onWarning ?? options.progress ?? ((line: string) => process.stderr.write(`skeinwise live: ${line}\n`));
  const background = config.liveOrganise
    ? new Background({
        store,
        home,
        statusFile,
        fetch: options.fetch ?? fetch,
        env: options.env ?? process.env,
        busy: options.once ? null : options.busy,
        ...(options.progress ? { progress: options.progress } : {}),
        onWarning: warn,
        onDone: () => options.onOrganised?.(loadStatus(statusFile, warn)),
        isolate: options.isolate ?? (!options.once && (options.fetch === undefined || options.fetch === globalThis.fetch)),
      })
    : null;
  const targets = defaultTargets(config.liveFolders, options.userHome, { downloads: config.liveDownloads });
  const capture = new LiveCapture(store, targets, {
    statusFile,
    onWarning: warn,
    onSaved: (status) => {
      options.onSaved?.(status);
      background?.trigger();
    },
  });
  const first = capture.scan();
  // Entries saved while live was off (by an import, a note, or an earlier live run cut off before it organised them)
  // are new to the organiser too, so a pass runs at start-up even when the catch-up found nothing.
  if (background && !background.active) background.trigger();

  const poll = options.poll ?? (async (): Promise<PollReport[]> => []);
  let stopped = false;
  let polling = false;
  // The start-up pull reports every connection it pulled; later ones only what brought something or failed.
  const pullOnce = async (quiet: boolean): Promise<void> => {
    if (polling || stopped) return;
    polling = true;
    try {
      const pulled = (await poll(store, home)).filter((r) => r.pulled);
      if (stopped) return;
      const told = quiet ? pulled.filter((r) => !r.ok || r.added + r.versioned + r.deleted > 0) : pulled;
      if (told.length) options.onPulled?.(told.map((r) => r.line));
      if (pulled.some((r) => r.added + r.versioned > 0)) background?.trigger();
    } catch (error) {
      // Only an unreadable connections.json throws; say so and keep capturing.
      if (!stopped) options.onPulled?.([`connectors: ${(error as Error).message}`]);
    } finally {
      polling = false;
    }
  };
  const pulled = pullOnce(false);
  const timer = options.once ? null : setInterval(() => void pullOnce(true), (options.pollSeconds ?? 60) * 1000);
  timer?.unref();

  if (!options.once) capture.start();
  return {
    capture,
    background,
    first,
    pulled,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      capture.stop();
      return background ? background.stop() : Promise.resolve();
    },
  };
}

export function describeStatus(status: LiveStatus): string {
  const [saved, caught] = statusLines(status);
  const errors = status.errors.map((e) => `  failed: ${e.path}: ${e.error}\n`).join('');
  return `${saved} · ${caught}\n${errors}`;
}
