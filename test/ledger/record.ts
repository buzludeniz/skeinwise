// A temp record folder holding the invented demo record, for the ledger's tests.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEMO_NOW, writeDemo } from '../../src/demo/demo.ts';
import { openHome } from '../../src/home.ts';
import { readImports } from '../../src/importers/detect.ts';
import type { Store } from '../../src/store/store.ts';

export interface TempRecord {
  dir: string;
  home: string;
  store: Store;
  /** Moves the store's clock. */
  setNow: (iso: string) => void;
  close: () => void;
}

export function demoRecord(): TempRecord {
  const dir = mkdtempSync(join(tmpdir(), 'skeinwise-ledger-'));
  const home = join(dir, 'home');
  let now = DEMO_NOW;
  const store = openHome(home, () => now);
  const exports = join(dir, 'exports');
  writeDemo(exports);
  for (const part of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const batch of readImports(join(exports, part))) store.ingest(batch);
  return {
    dir,
    home,
    store,
    setNow: (iso) => {
      now = iso;
    },
    close: () => {
      store.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
