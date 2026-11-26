// The full collection between run all's steps (src/organiser/gc.ts) must be a real one on every platform and Node the
// CI runs. If it quietly became a no-op, run all's peak memory would go back to wherever V8's limit happens to fall.

import { describe, expect, it } from 'vitest';
import { collectGarbage, fullGc } from '../src/organiser/gc.ts';

describe('collectGarbage', () => {
  it('has V8’s gc without a flag, and collects what nothing holds any more', async () => {
    expect(fullGc()).toBeTypeOf('function');
    const ref = new WeakRef(Array.from({ length: 1000 }, (_, i) => ({ i })));
    // A WeakRef keeps its target alive until the current job ends.
    await new Promise((resolve) => setImmediate(resolve));
    expect(collectGarbage()).toBe(true);
    expect(ref.deref()).toBeUndefined();
  });

  it('gives no gc to contexts made afterwards', async () => {
    fullGc();
    const { runInNewContext } = await import('node:vm');
    expect(runInNewContext('typeof gc')).toBe('undefined');
  });
});
