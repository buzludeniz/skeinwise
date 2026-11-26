// `pnpm fuzz`: a longer fuzz run than the suite's, from a random seed it prints first and last, so a finding replays.
//
//   pnpm fuzz                                   every target, 60 seconds in all
//   pnpm fuzz --seconds 600 --target docx,zip   two targets, 300 seconds each
//   pnpm fuzz --seed 123 --target docx --from 4711 --count 1   replay one input
//
// Other flags: --dir (where the targets' folders, findings.json and each finding's input go; default a new folder in
// the system's temporary folder, kept afterwards), --budget ms (slow past it, 3000), --hang ms (20000), --heap MB (2048).
// It exits 1 when there is a finding.

import { randomInt } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inputFor, type Finding } from './engine.ts';
import { fuzzTarget } from './pool.ts';
import { TARGETS, targetNamed } from './targets.ts';

const args = process.argv.slice(2);
const { values } = parseArgs({
  args: args[0] === '--' ? args.slice(1) : args,
  options: {
    seconds: { type: 'string', default: '60' },
    seed: { type: 'string' },
    target: { type: 'string' },
    dir: { type: 'string' },
    from: { type: 'string' },
    count: { type: 'string' },
    budget: { type: 'string', default: '3000' },
    hang: { type: 'string', default: '20000' },
    heap: { type: 'string', default: '2048' },
  },
});

function whole(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    console.error(`fuzz: --${flag} takes a whole number, not ${value}`);
    process.exit(2);
  }
  return n;
}

const seed = whole('seed', values.seed) ?? randomInt(2 ** 31);
const from = whole('from', values.from);
const count = whole('count', values.count) ?? 1;
if (from !== undefined && values.seed === undefined) {
  console.error('fuzz: --from replays inputs of one seed: give it with --seed');
  process.exit(2);
}
const targets = values.target ? values.target.split(',').map((name) => targetNamed(name.trim())) : TARGETS;
const seconds = whole('seconds', values.seconds)!;
const budgetMs = whole('budget', values.budget)!;
const hangMs = whole('hang', values.hang)!;
const heapMb = whole('heap', values.heap)!;
const dir = values.dir ? resolve(values.dir) : mkdtempSync(join(tmpdir(), 'skeinwise-fuzz-'));
mkdirSync(dir, { recursive: true });

console.log(`fuzz: seed ${seed}`);
console.log(`fuzz: writing to ${dir}`);
process.on('SIGINT', () => {
  console.log(`\nfuzz: stopped; seed ${seed}`);
  process.exit(130);
});

const findings: Finding[] = [];
const report: Array<{ target: string; owner: string; runs: number; refused: number; seconds: number; perSecond: number; findings: number }> = [];
for (const target of targets) {
  const folder = join(dir, target.name);
  mkdirSync(folder, { recursive: true });
  const replay = from !== undefined;
  const result = await fuzzTarget(target.name, {
    seed,
    start: from ?? 0,
    iterations: replay ? from + count : Number.MAX_SAFE_INTEGER,
    deadline: replay ? Infinity : Date.now() + (seconds * 1000) / targets.length,
    folder,
    budgetMs,
    hangMs,
    heapMb,
  });
  const perSecond = Math.round(result.runs / (result.ms / 1000));
  report.push({ target: target.name, owner: target.owner, runs: result.runs, refused: result.refused, seconds: Math.round(result.ms / 100) / 10, perSecond, findings: result.findings.length });
  const read = Math.round((100 * (result.runs - result.refused)) / Math.max(1, result.runs));
  console.log(`  ${target.name.padEnd(12)} ${String(result.runs).padStart(8)} inputs in ${(result.ms / 1000).toFixed(1)} s, ${perSecond}/s, ${read}% read, ${result.findings.length} findings`);
  for (const f of result.findings) {
    const file = join(dir, `${f.target}-${f.seed}-${f.iteration}.bin`);
    writeFileSync(file, inputFor(target, f.seed, f.iteration));
    console.log(`    ${f.kind} at input ${f.iteration} (${f.owner}): ${f.error.split('\n')[0]}`);
    console.log(`      replay: pnpm fuzz --seed ${f.seed} --target ${f.target} --from ${f.iteration} --count 1   input: ${file}`);
  }
  findings.push(...result.findings);
}

writeFileSync(join(dir, 'findings.json'), `${JSON.stringify({ seed, report, findings }, null, 2)}\n`);
console.log(`fuzz: ${findings.length} findings, in ${join(dir, 'findings.json')}`);
console.log(`fuzz: seed ${seed}`);
process.exitCode = findings.length ? 1 : 0;
