// File modes in tests. Windows has no owner-only modes for Node to report (statSync gives 0o666, or 0o444 when the
// read-only bit is set), so there the check comes down to the file existing. Every mode assert goes through
// expectMode, so the suite runs the same on all three OSes (plan 7.4).
import { statSync } from 'node:fs';
import { expect } from 'vitest';

/** False on Windows, where a test about modes alone should be `it.runIf(posixModes)`. */
export const posixModes = process.platform !== 'win32';

/** Expects `path` to have exactly `mode`, such as 0o600 or 0o700. On Windows, only that it exists. */
export function expectMode(path: string, mode: number): void {
  const stat = statSync(path);
  if (posixModes) expect(stat.mode & 0o777, path).toBe(mode);
}
