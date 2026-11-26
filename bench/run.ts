// The bench (`pnpm bench`, or `node bench/run.ts`): writes a seeded synthetic corpus, runs every measure of the v1 plan's performance budgets
// (section 7.2) on it, prints each against its budget, and exits 1 when any is over budget or fails to run.
//
//   node bench/run.ts [50k|150k] [--dir <folder>] [--keep] [--seed <n>] [--entries <n>]
//
// --entries writes a corpus of another size but keeps the named size's budgets: a quick check of the bench itself.
//
// Everything happens in one bench folder (default .skeinwise/bench/<size> in this checkout, which git ignores): the
// corpus, the record (SKEINWISE_HOME) and a stand-in home folder (HOME), so no measure reads a real history or record.
// The record's engine is `none`: nothing is sent to a model server, local or not. Each measure runs in a fresh
// process (bench/worker.ts), so it starts cold and its peak memory is its own; times are taken inside that process,
// from the command's start to its end, without Node's own start-up.
//
// The budgets are set for an M1 with 16 GB; a busier or smaller machine runs slower. The 50k bench takes a few
// minutes at full load on several cores, and the 150k one much longer.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, homedir, loadavg, platform, totalmem } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { configPath, loadConfig } from '../src/config.ts';
import { readStatus } from '../src/live/capture.ts';
import { BUDGETS, judge, percentile, report, type Result, show, SIZES, type Size } from './budgets.ts';
import { writeCorpus, writeIncrement } from './corpus.ts';
import type { Job, WorkerReport } from './worker.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
/** Marks a folder the bench made, so it only ever clears its own. */
const MARK = '.skeinwise-bench';

export const SEARCHES = [
  ['sqlite'],
  ['kubernetes'],
  ['sourdough'],
  ['mortgage'],
  ['marathon'],
  ['espresso'],
  ['postgres', 'index'],
  ['deploy', 'rollback'],
  ['budget', 'tax'],
  ['typescript', 'react'],
  ['cache', 'latency'],
  ['woodwork'],
  ['beekeeping'],
  ['decided'],
  ['migration', 'schema', 'query'],
  ['photography', '--source', 'chatgpt'],
  ['climbing', '--from', '2024-01-01'],
  ['index', '--speaker', 'you'],
  ['zettelkasten', '--limit', '50'],
  ['nothingmatchesthisword'],
];

export const QUESTIONS = ['when did I first mention sourdough', 'what did I decide about postgres', 'what changed in my thinking on kubernetes'];

export const MCP_CALLS: Extract<Job, { kind: 'mcp' }>['calls'] = [
  ...['sqlite', 'kubernetes', 'sourdough', 'deploy rollback', 'budget', 'espresso', 'migration schema', 'chess'].map((query) => ({ name: 'search', args: { query } })),
  ...QUESTIONS.map((question) => ({ name: 'ask', args: { question } })),
  { name: 'timeline', args: { limit: 20 } },
  { name: 'timeline', args: { limit: 20, newest_first: true } },
];

export interface BenchOptions {
  size: Size;
  dir: string;
  keep: boolean;
  seed: number;
  /** The corpus size; the size's own unless --entries gives another. */
  entries: number;
}

export function parseOptions(argv: string[]): BenchOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { dir: { type: 'string' }, keep: { type: 'boolean' }, seed: { type: 'string' }, entries: { type: 'string' } },
  });
  const size = (positionals[0] ?? '50k') as Size;
  if (!(size in SIZES) || positionals.length > 1) throw new Error(`Give one size, 50k or 150k, not "${positionals.join(' ')}".`);
  const seed = Number(values.seed ?? 42);
  if (!Number.isInteger(seed)) throw new Error(`--seed must be a whole number, not "${values.seed}".`);
  const entries = Number(values.entries ?? SIZES[size]);
  if (!Number.isInteger(entries) || entries < 1_000) throw new Error(`--entries must be a whole number of 1000 or more, not "${values.entries}".`);
  const dir = resolve(values.dir ?? join(ROOT, '.skeinwise', 'bench', size));
  return { size, dir, keep: values.keep === true, seed, entries };
}

/** Empties the bench folder: one the bench made before, or a new or empty one. Refuses anything else. */
export function prepare(dir: string): void {
  const home = homedir();
  if (dir === home || home.startsWith(dir + sep) || dir === resolve(home, '.skeinwise') || dir.startsWith(resolve(home, '.claude'))) {
    throw new Error(`${dir} holds a real home, record or history; give the bench a folder of its own.`);
  }
  if (existsSync(dir) && readdirSync(dir).length && !existsSync(join(dir, MARK))) {
    throw new Error(`${dir} is not empty and the bench didn't make it; give an empty or new folder.`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MARK), 'Made by bench/run.ts; it clears this folder on its next run.\n');
}

/**
 * Runs one job in a fresh worker. A worker still running after `timeout` ms is stopped and rejects with Stopped, which
 * carries the most resident memory seen in samples taken every second.
 */
export function runWorker(job: Job, env: NodeJS.ProcessEnv, timeout: number): Promise<WorkerReport> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(job)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    let sampled = 0;
    const sampler = setInterval(() => {
      if (child.pid !== undefined && child.exitCode === null) residentMB(child.pid).then((mb) => void (sampled = Math.max(sampled, mb)), () => {});
    }, 1_000);
    let stopped = false;
    const timer = setTimeout(() => {
      stopped = true;
      child.kill('SIGKILL');
    }, timeout);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(sampler);
      if (stopped) fail(new Stopped(timeout, sampled));
      else if (code !== 0) fail(new Error(err.trim().split('\n').slice(-3).join(' ') || `the worker exited ${code}`));
      else done(JSON.parse(out.trim().split('\n').pop()!) as WorkerReport);
    });
  });
}

export class Stopped extends Error {
  readonly after: number;
  /** The most resident memory seen before the stop, in MB; 0 when no sample was taken. */
  readonly peakMB: number;
  constructor(after: number, peakMB: number) {
    super(`stopped after ${show(after, 'ms')}`);
    this.after = after;
    this.peakMB = peakMB;
  }
}

const limitOf = (key: string, size: Size): number => {
  const b = BUDGETS.find((x) => x.key === key)!;
  return b.limit[size] ?? b.limit['50k']!;
};

const say = (line: string) => process.stderr.write(`bench: ${line}\n`);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean | Promise<boolean>, timeout: number, every = 100): Promise<boolean> {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (await check()) return true;
    await sleep(every);
  }
  return false;
}

export async function bench(opts: BenchOptions): Promise<number> {
  const { size, entries } = opts;
  const loadAtStart = loadavg()[0]!;
  prepare(opts.dir);
  const home = join(opts.dir, 'home');
  const user = join(opts.dir, 'user');
  mkdirSync(home, { recursive: true });
  mkdirSync(user, { recursive: true });
  // No model: background passes and every command in the bench run the No-AI engine.
  writeFileSync(configPath(home), `${JSON.stringify({ engine: 'none' })}\n`);
  if (loadConfig(home).engine !== 'none') throw new Error("The bench record's engine isn't none; refusing to run.");
  const env: NodeJS.ProcessEnv = { ...process.env, SKEINWISE_HOME: home, HOME: user, USERPROFILE: user, NO_COLOR: '1' };

  say(`writing the ${size} corpus (seed ${opts.seed}) in ${opts.dir}`);
  const corpus = writeCorpus(join(opts.dir, 'corpus'), entries, opts.seed);
  const results = new Map<string, Result>();
  const measure = async (keys: string[], what: string, fn: () => Promise<void>) => {
    say(what);
    try {
      await fn();
    } catch (err) {
      for (const k of keys) if (!results.has(k)) results.set(k, { error: message(err) });
    }
  };

  await measure(['import.time', 'import.memory'], 'import', async () => {
    const r = await runWorker({ kind: 'cli', runs: [['import', ...corpus.paths]] }, env, 10 * limitOf('import.time', size));
    results.set('import.time', { value: r.times[0]! });
    results.set('import.memory', { value: r.peakMB });
  });

  await measure(['search.p95', 'ask.time', 'similar.time'], 'search, ask and similar', async () => {
    const ids = [Math.round(entries * 0.25), Math.round(entries * 0.75), entries - 100];
    const runs = [
      ...SEARCHES.map((q) => ['search', ...q]),
      ...QUESTIONS.map((q) => ['ask', q, '--engine', 'none']),
      ...ids.map((id) => ['similar', String(id)]),
      ['stats', '--json'],
    ];
    const r = await runWorker({ kind: 'cli', runs }, env, 600_000);
    const [search, ask, similar] = [r.times.slice(0, SEARCHES.length), r.times.slice(SEARCHES.length, -4), r.times.slice(-4, -1)];
    const imported = (JSON.parse(r.out.at(-1)!) as { entries: number }).entries;
    const note = `${search.length} searches; ${imported.toLocaleString('en')} entries`;
    results.set('search.p95', { value: percentile(search, 95), note });
    results.set('ask.time', { value: Math.max(...ask), note: `${ask.length} questions` });
    results.set('similar.time', { value: Math.max(...similar), note: `entries ${ids.join(', ')}` });
    if (imported !== entries) results.set('import.time', { error: `${imported} of the ${entries} entries written were imported` });
  });

  let organised = false;
  await measure(['runAll.time', 'runAll.memory'], 'first run all --engine none (the longest step)', async () => {
    const limit = 2 * limitOf('runAll.time', size);
    try {
      const r = await runWorker({ kind: 'cli', runs: [['run', 'all', '--engine', 'none']] }, env, limit);
      results.set('runAll.time', { value: r.times[0]! });
      results.set('runAll.memory', { value: r.peakMB });
      organised = true;
    } catch (err) {
      if (!(err instanceof Stopped)) throw err;
      results.set('runAll.time', { value: err.after, note: 'stopped at twice the budget' });
      // Memory seen before the stop is a floor: over budget if it already was, otherwise not known.
      results.set(
        'runAll.memory',
        err.peakMB > limitOf('runAll.memory', size)
          ? { value: err.peakMB, note: 'at least: sampled until the run was stopped' }
          : { error: `not known: the run was stopped at ${show(err.peakMB, 'MB')}` },
      );
    }
  });

  await measure(['incremental.time'], 'organise 100 new entries', async () => {
    if (!organised) throw new Error('not measured: the first run all did not finish, so every entry is still new');
    const increment = writeIncrement(join(opts.dir, 'corpus'), 100);
    const runs = [['import', increment], ['run', 'all', '--engine', 'none', '--scope', 'new']];
    const r = await runWorker({ kind: 'cli', runs }, env, 3 * limitOf('incremental.time', size));
    results.set('incremental.time', { value: r.times[1]! });
  });

  await measure(['brain.gzip'], '/api/brain', async () => {
    const r = await runWorker({ kind: 'brain', scanRoot: user }, env, 300_000);
    results.set('brain.gzip', { value: r.sizes[0]! / 1000, note: `${show(r.times[0]!, 'ms')} on this computer` });
  });

  await measure(['mcp.p95', 'mcp.size'], 'MCP calls', async () => {
    const r = await runWorker({ kind: 'mcp', calls: MCP_CALLS, hubs: 3 }, env, 300_000);
    results.set('mcp.p95', { value: percentile(r.times, 95), note: `${r.times.length} calls` });
    results.set('mcp.size', { value: Math.max(...r.sizes) / 1024 });
  });

  await measure(['live.searchable', 'live.idle'], 'live', () => live(env, home, user, results));

  await measure(['demo.time'], 'demo', async () => {
    const demoEnv = { ...env, SKEINWISE_HOME: join(opts.dir, 'demo-home') };
    const r = await runWorker({ kind: 'cli', runs: [['demo', '--out', join(opts.dir, 'demo-exports')]] }, demoEnv, 60_000);
    results.set('demo.time', { value: r.times[0]! });
  });

  await measure(['web.js'], 'web initial JS', async () => {
    results.set('web.js', webInitialJs(join(ROOT, 'dist', 'web')));
  });

  const load = `load ${loadAtStart.toFixed(1)} at the start and ${loadavg()[0]!.toFixed(1)} at the end`;
  const machine = `Node ${process.version}, ${platform()} ${arch()}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, ${load}`;
  const rows = judge(size, results);
  const corpusSize = entries === SIZES[size] ? `${entries.toLocaleString('en')} entries` : `a check run on ${entries.toLocaleString('en')} entries, not ${size}`;
  process.stdout.write(`Skeinwise bench, ${size} budgets (${corpusSize}, seed ${opts.seed}). ${machine}.\n`);
  process.stdout.write('Budgets are set for an M1 with 16 GB.\n\n');
  process.stdout.write(report(size, rows));
  if (!opts.keep) rmSync(opts.dir, { recursive: true, force: true });
  else say(`kept ${opts.dir}`);
  return rows.some((r) => r.verdict === 'over' || r.verdict === 'failed') ? 1 : 0;
}

/**
 * Starts `skeinwise live`, appends one message to a Claude Code session in the stand-in home, and times how long it
 * takes to show up in search. Then, once the background pass it starts is over, reads live's resident memory.
 */
async function live(env: NodeJS.ProcessEnv, home: string, user: string, results: Map<string, Result>): Promise<void> {
  const project = join(user, '.claude', 'projects', '-home-bench-code-live');
  mkdirSync(project, { recursive: true });
  const session = join(project, '0b5e2c1a-7d4f-4e1b-9c3a-5f6e7d8c9b0a.jsonl');
  let t = Date.parse('2026-11-20T10:00:00Z');
  const line = (role: 'user' | 'assistant', text: string) =>
    `${JSON.stringify({ type: role, sessionId: 'bench-live', uuid: `bench-${(t += 60_000)}`, timestamp: new Date(t).toISOString(), cwd: '/home/bench/code/live', message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } })}\n`;
  writeFileSync(session, line('user', 'Starting the live bench session.') + line('assistant', 'Ready when you are.'));

  const child = spawn(process.execPath, [CLI, 'live'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (err += d.toString()));
  const exited = new Promise<number | null>((r) => child.on('close', r));
  const statusFile = join(home, 'live.json');
  const passAfter = (since: number) => () => {
    const o = existsSync(statusFile) ? readStatus(statusFile).organised : undefined;
    return !!o && (Date.parse(o.at) >= since || !!o.waiting);
  };
  try {
    if (!(await waitFor(() => out.includes('Recording live.') || child.exitCode !== null, 300_000))) throw new Error('live did not start in 5 min');
    if (child.exitCode !== null) throw new Error(`live exited ${child.exitCode}: ${err.trim().slice(-300)}`);
    await waitFor(passAfter(0), 120_000, 250); // the start-up pass over the session above

    const word = `zqv${Array.from({ length: 8 }, (_, i) => String.fromCharCode(97 + ((i * 7 + Date.now()) % 26))).join('')}`;
    const { main } = await import('../src/cli.ts');
    const found = async () => {
      let printed = '';
      const code = await main(['search', word, '--json'], { out: (s) => void (printed += s), err: () => {}, env }).catch(() => 1);
      return code === 0 && (JSON.parse(printed) as unknown[]).length > 0;
    };
    const written = performance.now();
    const writtenAt = Date.now();
    appendFileSync(session, line('user', `Live bench probe: ${word} should be searchable within seconds.`));
    if (await waitFor(found, 30_000)) results.set('live.searchable', { value: performance.now() - written });
    else results.set('live.searchable', { value: 30_000, note: 'not searchable after 30 s' });

    await waitFor(passAfter(writtenAt), 300_000, 250);
    await sleep(3_000);
    const organised = existsSync(statusFile) ? readStatus(statusFile).organised : undefined;
    const rss = await residentMB(child.pid!);
    const note = organised?.waiting ? `no background pass ran: ${organised.waiting}` : organised?.error ? `the pass stopped: ${organised.error}` : 'after one append and its background pass';
    results.set('live.idle', { value: rss, note });
  } finally {
    child.kill('SIGINT');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(timer);
  }
}

/** A process's resident memory in MB, from ps (macOS and Linux). */
function residentMB(pid: number): Promise<number> {
  return new Promise((done, fail) => {
    const ps = spawn('ps', ['-o', 'rss=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout.on('data', (d: Buffer) => (out += d.toString()));
    ps.on('error', fail);
    ps.on('close', () => {
      const kb = Number(out.trim());
      if (!out.trim() || !Number.isFinite(kb)) fail(new Error(`ps gave no memory for process ${pid}`));
      else done(kb / 1024);
    });
  });
}

/** The gzip size of the JS the built page loads before anything else: its module scripts and their preloads. */
export function webInitialJs(webDir: string): Result {
  const index = join(webDir, 'index.html');
  if (!existsSync(index)) return { error: 'no dist/web: run pnpm build first' };
  const html = readFileSync(index, 'utf8');
  const files = new Set<string>();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const isScript = tag.startsWith('<script') && /\btype="module"/.test(tag);
    const isPreload = tag.startsWith('<link') && /\brel="modulepreload"/.test(tag);
    const src = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1];
    if ((isScript || isPreload) && src) files.add(src.replace(/^\.?\//, ''));
  }
  if (!files.size) return { error: `no module script in ${index}` };
  let bytes = 0;
  for (const f of files) bytes += gzipSync(readFileSync(join(webDir, f))).length;
  return { value: bytes / 1000, note: `${files.size} file${files.size === 1 ? '' : 's'}` };
}

if (import.meta.main) {
  try {
    process.exitCode = await bench(parseOptions(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`bench: ${message(err)}\n`);
    process.exitCode = 2;
  }
}
