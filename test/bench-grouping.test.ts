// bench/grouping.ts: the invented record it times grouping on, and the timing itself on a small one. The 50,000-entry
// run is the bench's (`node bench/grouping.ts --bound 60`); this keeps the script working.

import { describe, expect, it } from 'vitest';
import { inventedEntries, timeGrouping } from '../bench/grouping.ts';
import { isDailyNote } from '../src/organiser/record.ts';

describe('bench/grouping.ts', () => {
  it('invents the same record from the same seed, in the bench corpus’s shape', () => {
    const a = inventedEntries(2000, 7);
    expect(inventedEntries(2000, 7)).toEqual(a);
    expect(inventedEntries(2000, 8)).not.toEqual(a);
    expect(a).toHaveLength(2000);
    const kinds = (k: string) => a.filter((e) => e.sourceKind === k).length;
    expect([kinds('chatgpt'), kinds('claude-code'), kinds('note')]).toEqual([1200, 600, 200]);
    expect(a.filter(isDailyNote)).toHaveLength(36);
    expect(a.every((e) => e.body.includes('[[') === (e.kind === 'note'))).toBe(true);
  });

  it('times grouping and fingerprints the groups, the same each run', () => {
    const a = timeGrouping(1500);
    const b = timeGrouping(1500);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a).toMatchObject({ entries: 1500, loose: 0 });
    expect(a.groups).toBeGreaterThan(1);
    expect(a.units).toBeGreaterThan(a.groups);
  });
});
