// A short, seeded fuzz run with the suite: every target in a worker, the same inputs every time, so a finding here is a
// regression that replays (`pnpm fuzz --seed 20261125 --target <name> --from <input> --count 1`). Longer runs from a
// random seed: `pnpm fuzz`. The harness's own tests plant each kind of failure and check it is caught.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inputFor, loop, runOne, type Finding, type Target } from './engine.ts';
import { fuzzTarget, type PoolOptions } from './pool.ts';
import { TARGETS, targetNamed } from './targets.ts';

const SEED = 20261125;
/** Inputs per target: about half a second each on a loaded machine. */
const COUNT: Record<string, number> = { text: 400, lines: 300, xml: 800, docx: 200, import: 200, frontmatter: 400, zip: 300, 'safe-text': 100, 'view-spec': 2000, 'view-routes': 300 };
const TIMEOUT = 120_000;

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'skeinwise-fuzz-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const options = (name: string, iterations: number, extra: Partial<PoolOptions> = {}): PoolOptions => ({
  seed: SEED,
  iterations,
  deadline: Infinity,
  folder: folder(name),
  budgetMs: 3000,
  hangMs: 20_000,
  heapMb: 2048,
  ...extra,
});

const line = (f: Finding) => `${f.kind} in ${f.target} (${f.owner}) at input ${f.iteration} of seed ${f.seed}: ${f.error.split('\n')[0]}`;

describe('fuzzing', () => {
  it('covers every target with a count', () => {
    expect(TARGETS.map((t) => t.name).sort()).toEqual(Object.keys(COUNT).sort());
  });

  for (const target of TARGETS) {
    const count = COUNT[target.name] ?? 0;
    it(
      `${target.name} (${target.owner}): ${count} seeded inputs are each read or refused, within the budget and the caps`,
      async () => {
        const { runs, findings } = await fuzzTarget(target.name, options(target.name, count));
        expect(findings.map(line)).toEqual([]);
        expect(runs).toBe(count);
      },
      TIMEOUT,
    );
  }

  it('replays: the same seed and input number build the same input, and another number another', () => {
    for (const target of TARGETS) expect(inputFor(target, SEED, 7)).toEqual(inputFor(target, SEED, 7));
    const docx = targetNamed('docx');
    expect(inputFor(docx, SEED, 7)).not.toEqual(inputFor(docx, SEED, 8));
  });

  it('replays the same bytes when the clock moves between two builds', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const target of TARGETS) {
        vi.setSystemTime(new Date('2026-11-27T05:00:00'));
        const first = inputFor(target, SEED, 7);
        vi.setSystemTime(new Date('2026-11-27T05:00:05'));
        expect(inputFor(target, SEED, 7), target.name).toEqual(first);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the fuzz harness catches', () => {
  const planted = (run: Target['run'], extra: Partial<Target> = {}): Target => ({
    name: 'planted',
    owner: 'test',
    memoryMiB: 64,
    seeds: () => [new Uint8Array([1])],
    tokens: ['x'],
    run,
    refused: () => false,
    ...extra,
  });

  it('a broken rule and a slow input, and lets a promised refusal pass', async () => {
    const dir = folder('planted-inline');
    expect(await runOne(planted(() => void (null as unknown as { x: number }).x), new Uint8Array(1), dir, 1000)).toMatchObject({ kind: 'error', error: expect.stringMatching(/^TypeError/) });
    const refusal = planted(() => { throw new RangeError('no'); }, { refused: (e) => e instanceof RangeError });
    const refused = await runOne(refusal, new Uint8Array(1), dir, 1000);
    expect(refused.refused).toBe(true);
    expect(refused.kind).toBeUndefined();
    const slow = planted(() => { const end = performance.now() + 30; while (performance.now() < end); });
    expect(await runOne(slow, new Uint8Array(1), dir, 5)).toMatchObject({ kind: 'slow', error: expect.stringMatching(/past the 5 ms budget/) });
  });

  it('a worker that exits, and carries on with the next input in a new one', async () => {
    const { runs, findings } = await fuzzTarget('planted-exit', options('planted-exit', 2));
    expect(findings.map((f) => [f.kind, f.iteration, f.error])).toEqual([
      ['crash', 0, 'the worker exited with code 7'],
      ['crash', 1, 'the worker exited with code 7'],
    ]);
    expect(runs).toBe(2);
  }, TIMEOUT);

  it('a hang, at exactly the inputs that hang, and runs the rest', async () => {
    const target = targetNamed('planted-hang');
    const hanging = [...Array(8).keys()].filter((i) => inputFor(target, SEED, i)[0] === 0);
    expect(hanging.length).toBeGreaterThan(0);
    expect(hanging.length).toBeLessThan(8);
    const { runs, findings } = await fuzzTarget('planted-hang', options('planted-hang', 8, { hangMs: 300 }));
    expect(findings.map((f) => f.kind)).toEqual(hanging.map(() => 'hang'));
    expect(findings.map((f) => f.iteration)).toEqual(hanging);
    expect(runs).toBe(8);
  }, TIMEOUT);

  it('a promise that never settles, as a hang', async () => {
    const { runs, findings } = await fuzzTarget('planted-stall', options('planted-stall', 1, { hangMs: 300 }));
    expect(findings.map((f) => [f.kind, f.iteration])).toEqual([['hang', 0]]);
    expect(runs).toBe(1);
  }, TIMEOUT);

  it('a heap that runs out', async () => {
    const { findings } = await fuzzTarget('planted-heap', options('planted-heap', 1, { heapMb: 32 }));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'crash', iteration: 0, error: expect.stringMatching(/memory/i) });
  }, TIMEOUT);

  it('a write outside the folder, and refuses it', async () => {
    const dir = folder('planted-write');
    const { findings } = await fuzzTarget('planted-write', { ...options('planted-write', 1), folder: dir });
    expect(findings.map((f) => f.kind)).toEqual(['write']);
    expect(findings[0]!.error).toContain('outside.txt');
    expect(existsSync(join(dir, '..', 'outside.txt'))).toBe(false);
  }, TIMEOUT);

  it('a write in its folder but outside where the target may write, after the set-up it asked for', async () => {
    const dir = folder('planted-narrow');
    const { findings } = await fuzzTarget('planted-narrow', { ...options('planted-narrow', 1), folder: dir });
    expect(findings.map((f) => f.kind)).toEqual(['write']);
    expect(findings[0]!.error).toContain('wide.txt');
    expect(findings[0]!.error).not.toContain('narrow.txt');
    expect(existsSync(join(dir, 'inner', 'narrow.txt'))).toBe(true);
    expect(existsSync(join(dir, 'wide.txt'))).toBe(false);
  }, TIMEOUT);

  it('memory an input keeps, past its budget', async () => {
    const kept: Buffer[] = [];
    const findings: Finding[] = [];
    const greedy = planted(() => void kept.push(Buffer.alloc(200 * 1024 ** 2, 1)));
    await loop(greedy, { seed: SEED, start: 0, iterations: 1, deadline: Infinity, folder: folder('planted-memory'), budgetMs: 60_000, onFinding: (f) => findings.push(f) });
    kept.length = 0;
    expect(findings.map((f) => f.kind)).toEqual(['memory']);
  });

  it('a file an input leaves open, counted the same way on every system', async () => {
    const { findings } = await fuzzTarget('planted-leak', options('planted-leak', 1));
    expect(findings.map((f) => [f.kind, f.error])).toEqual([['leak', 'it left 1 file open on 1 bytes']]);
  }, TIMEOUT);
});
