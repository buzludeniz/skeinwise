// `skeinwise live`: the update stream from the command line. Capture imports what changes; after each save the
// background organiser runs over what is new.

import { join } from 'node:path';
import { loadConfig } from '../config.ts';
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
}

export interface LiveRun {
  capture: LiveCapture;
  /** Null when `liveOrganise` is off. */
  background: Background | null;
  /** Whatever was found on start-up (everything changed since the last pass). */
  first: LiveStatus;
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
  if (!options.once) capture.start();
  return {
    capture,
    background,
    first,
    stop: () => {
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
