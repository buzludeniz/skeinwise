// `skeinwise live`: the capture half of the update stream, from the command line.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/store.ts';
import { defaultTargets, LiveCapture, type LiveStatus, statusLines } from './capture.ts';

/** The `live` part of `<home>/config.json`: the note folders and vaults to follow, and whose words they hold. */
export function liveFolders(home: string): { path: string; owner?: string }[] {
  const file = join(home, 'config.json');
  if (!existsSync(file)) return [];
  const config = JSON.parse(readFileSync(file, 'utf8')) as { live?: { folders?: { path: string; owner?: string }[] } };
  return config.live?.folders ?? [];
}

export interface LiveRun {
  capture: LiveCapture;
  /** Whatever was found on start-up (everything changed since the last pass). */
  first: LiveStatus;
}

/**
 * Catches up on what changed since the last pass, then (unless `once`) keeps watching. `onSaved` runs after every
 * pass that saved something; it is where background organising hooks in.
 */
export function startLive(
  store: Store,
  home: string,
  options: { once?: boolean; userHome?: string; onSaved?: (status: LiveStatus) => void } = {},
): LiveRun {
  const targets = defaultTargets(liveFolders(home), options.userHome);
  const capture = new LiveCapture(store, targets, { statusFile: join(home, 'live.json'), onSaved: options.onSaved });
  const first = capture.scan();
  if (!options.once) capture.start();
  return { capture, first };
}

export function describeStatus(status: LiveStatus): string {
  const [saved, caught] = statusLines(status);
  const errors = status.errors.map((e) => `  failed: ${e.path}: ${e.error}\n`).join('');
  return `${saved} · ${caught}\n${errors}`;
}
