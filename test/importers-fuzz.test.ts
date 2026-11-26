// A short, seeded run of the import parsers' fuzz harness (test/fuzz/importers.ts) with the suite: the same inputs
// every time, so a finding here is a regression that replays. Long runs go through the harness's own command.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fuzz, inputFor, runOne, TARGETS, type Target } from './fuzz/importers.ts';

const SEED = 20261125;
const ITERATIONS = 150;

function withScratch<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'skeinwise-fuzz-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the import parsers under fuzzing', () => {
  for (const target of TARGETS) {
    it(`${target.name}: ${ITERATIONS} seeded inputs are each read or refused, never crash, and stay fast`, () => {
      withScratch((scratch) => {
        const { runs, findings } = fuzz({ seed: SEED, iterations: ITERATIONS, targets: [target], scratch, budgetMs: 3000 });
        expect(runs[target.name]).toBe(ITERATIONS);
        expect(findings.map((f) => `${f.target} seed ${f.seed} iteration ${f.iteration}: ${f.error.split('\n')[0]}`)).toEqual([]);
      });
    });
  }

  it('replays: the same seed and iteration build the same input', () => {
    for (const target of TARGETS) expect(inputFor(target, SEED, 7)).toEqual(inputFor(target, SEED, 7));
    expect(inputFor(TARGETS[0]!, SEED, 7)).not.toEqual(inputFor(TARGETS[0]!, SEED, 8));
  });

  it('reports a crash, a broken rule and a slow input, and lets a promised refusal pass', () => {
    withScratch((scratch) => {
      const base = { name: 'planted', seeds: () => [new Uint8Array([1])], tokens: ['x'] };
      const crash: Target = { ...base, run: () => void (null as unknown as { x: number }).x, refused: () => false };
      const refusal: Target = { ...base, run: () => { throw new RangeError('no'); }, refused: (e) => e instanceof RangeError };
      const slow: Target = { ...base, run: () => { const end = performance.now() + 30; while (performance.now() < end); }, refused: () => false };
      expect(runOne(crash, new Uint8Array(1), scratch, 1000).error).toMatch(/^TypeError/);
      expect(runOne(refusal, new Uint8Array(1), scratch, 1000).error).toBeUndefined();
      expect(runOne(slow, new Uint8Array(1), scratch, 5).error).toMatch(/past the 5 ms budget/);
    });
  });
});
