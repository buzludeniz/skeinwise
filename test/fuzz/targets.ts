// Every fuzz target by name: the import parsers this track owns, the shared code they use, and the planted targets the
// harness's own tests run to show it catches a crash, a hang, a heap that runs out and a write outside the folder.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Target } from './engine.ts';
import { IMPORTER_TARGETS } from './importers.ts';
import { SHARED_TARGETS } from './shared.ts';

/** The targets a fuzz run covers. */
export const TARGETS: Target[] = [...IMPORTER_TARGETS, ...SHARED_TARGETS];

const planted = (name: string, run: Target['run'], extra: Partial<Target> = {}): Target => ({
  name: `planted-${name}`,
  owner: 'test/fuzz (planted)',
  memoryMiB: 256,
  seeds: () => [new Uint8Array([0]), new Uint8Array([1])],
  tokens: [],
  // Each input is one of the seeds as it is, so a test can tell which iterations get which.
  mutate: (_rng, seed) => seed,
  run,
  refused: () => false,
  ...extra,
});

/** Broken on purpose, for the harness's tests: never in a fuzz run. */
export const PLANTED: Target[] = [
  planted('exit', () => process.exit(7)),
  planted('hang', (input) => {
    if (input[0] === 0) for (;;);
  }),
  planted('heap', () => {
    const kept: number[][] = [];
    for (;;) kept.push(Array.from({ length: 1e5 }, (_, i) => i));
  }),
  planted('write', (_input, file) => writeFileSync(join(dirname(file), '..', 'outside.txt'), 'x'), { fileName: 'input.bin' }),
];

export function targetNamed(name: string): Target {
  const target = [...TARGETS, ...PLANTED].find((t) => t.name === name);
  if (!target) throw new Error(`No fuzz target is named ${name}. The targets: ${TARGETS.map((t) => t.name).join(', ')}`);
  return target;
}
