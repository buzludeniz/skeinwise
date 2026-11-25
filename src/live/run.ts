// `skeinwise live`: the update stream from the command line. Capture imports what changes, the connectors pull from
// the services you connected; after each save the background organiser runs over what is new.

import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { type PollReport, pollConnectors } from '../connectors/poll.ts';
import type { Store } from '../store/store.ts';
import { defaultTargets, LiveCapture, type LiveStatus, readStatus, statusLines } from './capture.ts';
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
  /** After every connector pull that read something or failed: one line per connection, or the error. */
  onPulled?: (lines: string[]) => void;
  /** Seconds between connector checks (default 60). Each connection keeps its own pace; most checks pull nothing. */
  pollSeconds?: number;
  /** Replaces the connectors' pull (tests). */
  poll?: (store: Store, home: string) => Promise<PollReport[]>;
}

export interface LiveRun {
  capture: LiveCapture;
  /** Null when `liveOrganise` is off. */
  background: Background | null;
  /** Whatever was found on start-up (everything changed since the last pass). */
  first: LiveStatus;
  /** The start-up connector pull; with `once`, await it before `background.idle()`. */
  pulled: Promise<void>;
  /** Stops watching and organising; a run cut off mid-way is marked failed. */
  stop: () => void;
}

/**
 * Catches up on what changed since the last pass, starts a background pass when anything is new, and (unless `once`)
 * keeps watching. With `once`, await `background.idle()` before closing the store.
 */
export function startLive(store: Store, home: string, options: LiveOptions = {}): LiveRun {
  const config = loadConfig(home);
  const statusFile = join(home, 'live.json');
  const background = config.liveOrganise
    ? new Background({
        store,
        home,
        statusFile,
        fetch: options.fetch ?? fetch,
        env: options.env ?? process.env,
        busy: options.once ? null : options.busy,
        ...(options.progress ? { progress: options.progress } : {}),
        onDone: () => options.onOrganised?.(readStatus(statusFile)),
      })
    : null;
  const targets = defaultTargets(config.liveFolders, options.userHome);
  const capture = new LiveCapture(store, targets, {
    statusFile,
    onSaved: (status) => {
      options.onSaved?.(status);
      background?.trigger();
    },
  });
  const first = capture.scan();
  // Entries saved while live was off (by an import, a note, or an earlier live run cut off before it organised them)
  // are new to the organiser too, so a pass runs at start-up even when the catch-up found nothing.
  if (background && !background.active) background.trigger();

  const poll = options.poll ?? ((s: Store, h: string) => pollConnectors(s, h));
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
      background?.stop();
    },
  };
}

export function describeStatus(status: LiveStatus): string {
  const [saved, caught] = statusLines(status);
  const errors = status.errors.map((e) => `  failed: ${e.path}: ${e.error}\n`).join('');
  return `${saved} · ${caught}\n${errors}`;
}
