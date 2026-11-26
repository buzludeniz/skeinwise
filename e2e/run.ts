// Where the e2e run keeps its record: SKEINWISE_E2E_RUN when it is set, else e2e/.run. Each run empties the folder
// first, so a folder named by SKEINWISE_E2E_RUN is emptied only when it is new, empty or marked as an earlier run's.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The default run folder, inside this checkout and ignored by git. */
const DEFAULT_RUN = join(import.meta.dirname, '.run');

/** The file a run leaves in its folder, so the next run knows the folder is its own to empty. */
export const RUN_MARK = '.skeinwise-e2e-run';

export function runFolder(): string {
  return process.env.SKEINWISE_E2E_RUN || DEFAULT_RUN;
}

/**
 * Empties the run folder and marks it. A folder that holds files but no mark is refused and left as it is: a
 * SKEINWISE_E2E_RUN pointed at the wrong place, such as a record folder, must never be wiped.
 */
export function freshRunFolder(run: string): void {
  const own = resolve(run) === DEFAULT_RUN || existsSync(join(run, RUN_MARK));
  if (existsSync(run) && !own && readdirSync(run).length > 0) {
    throw new Error(`${run} holds files and is not an e2e run folder. Set SKEINWISE_E2E_RUN to a new or empty folder.`);
  }
  rmSync(run, { recursive: true, force: true });
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, RUN_MARK), '');
}
