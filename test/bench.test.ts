// The bench's own parts (LS-31): the seeded corpus, the budget table and verdict, the worker's three kinds of job,
// and the guard on the bench folder. `pnpm bench` itself runs outside the suite: it takes minutes at full load.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { BUDGETS, judge, percentile, report, type Result } from '../bench/budgets.ts';
import { planCorpus, writeCorpus, writeIncrement } from '../bench/corpus.ts';
import { MCP_CALLS, mcpResults, parseOptions, prepare, runWorker, Stopped, webInitialJs } from '../bench/run.ts';
import { work } from '../bench/worker.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-bench-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** One hash over every file's path and bytes. */
function treeHash(root: string): string {
  const hash = createHash('sha256');
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else hash.update(relative(root, p)).update(readFileSync(p));
    }
  };
  walk(root);
  return hash.digest('hex');
}

describe('bench corpus', () => {
  it('writes the same files for the same seed and different ones for another', () => {
    writeCorpus(join(dir, 'a'), 1_500);
    writeCorpus(join(dir, 'b'), 1_500);
    writeCorpus(join(dir, 'c'), 1_500, 43);
    expect(treeHash(join(dir, 'a'))).toBe(treeHash(join(dir, 'b')));
    expect(treeHash(join(dir, 'a'))).not.toBe(treeHash(join(dir, 'c')));
  });

  it('imports to exactly the planned number of entries, and the increment adds 100 more', async () => {
    const corpus = writeCorpus(join(dir, 'corpus'), 1_500);
    expect(planCorpus(1_500)).toEqual({ chatgpt: 900, claudeCode: 450, notes: 150 });
    const increment = writeIncrement(join(dir, 'corpus'), 100);
    const env = { SKEINWISE_HOME: join(dir, 'home'), HOME: join(dir, 'user') };
    const r = await work({ kind: 'cli', runs: [['import', ...corpus.paths], ['stats', '--json'], ['import', increment], ['stats', '--json']] }, env);
    expect(JSON.parse(r.out[1]!).entries).toBe(1_500);
    expect(JSON.parse(r.out[3]!).entries).toBe(1_600);
    expect(r.times).toHaveLength(4);
    expect(r.peakMB).toBeGreaterThan(0);
  });
});

describe('bench worker', () => {
  it('refuses to run without a record folder of its own', async () => {
    await expect(work({ kind: 'cli', runs: [['stats']] }, {})).rejects.toThrow(/SKEINWISE_HOME/);
  });

  it('loads /api/brain gzipped and answers every MCP call the bench makes', async () => {
    const corpus = writeCorpus(join(dir, 'corpus'), 600);
    const env = { SKEINWISE_HOME: join(dir, 'home'), HOME: join(dir, 'user') };
    await work({ kind: 'cli', runs: [['import', ...corpus.paths]] }, env);
    const brain = await work({ kind: 'brain', scanRoot: join(dir, 'user') }, env);
    expect(brain.sizes[0]).toBeGreaterThan(100);
    const mcp = await work({ kind: 'mcp', calls: MCP_CALLS, hubs: 3 }, env);
    expect(mcp.times).toHaveLength(MCP_CALLS.length + 1); // list_hubs; no hubs before a run, so no read_hub
    expect(mcp.tools).toEqual(['list_hubs', ...MCP_CALLS.map((c) => c.name)]);
    expect(Math.min(...mcp.sizes)).toBeGreaterThan(0);
    await work({ kind: 'cli', runs: [['run', 'hub', '--engine', 'none']] }, env);
    const withHubs = await work({ kind: 'mcp', calls: [], hubs: 3 }, env);
    expect(withHubs.times.length).toBeGreaterThan(1); // list_hubs, then read_hub for each hub it listed
  });
});

describe('bench budgets', () => {
  it('holds every measured budget of the plan, at both sizes where the plan sets one', () => {
    expect(BUDGETS.map((b) => b.key)).toEqual([
      'import.time', 'import.memory', 'search.p95', 'ask.time', 'similar.time', 'runAll.time', 'runAll.memory',
      'incremental.time', 'live.searchable', 'live.idle', 'brain.gzip', 'web.js', 'mcp.p95', 'mcp.ask', 'mcp.size',
      'demo.time',
    ]);
    expect(BUDGETS.find((b) => b.key === 'runAll.time')!.limit).toEqual({ '50k': 180_000, '150k': 720_000 });
    expect(BUDGETS.find((b) => b.key === 'mcp.p95')!.limit).toEqual({ '50k': 200, '150k': 400 });
    // An MCP ask with engine none is the same work as `ask --engine none`, so it takes the CLI's budget.
    expect(BUDGETS.find((b) => b.key === 'mcp.ask')!.limit).toEqual(BUDGETS.find((b) => b.key === 'ask.time')!.limit);
  });

  it('calls a measure over its budget over, a missing or broken one failed, and one without a budget none', () => {
    const results = new Map<string, Result>(BUDGETS.map((b) => [b.key, { value: 1 }]));
    results.set('search.p95', { value: 151 });
    results.set('live.idle', { error: 'ps gave no memory' });
    results.delete('web.js');
    const rows = judge('50k', results);
    const verdict = (key: string) => rows.find((r) => r.budget.key === key)!.verdict;
    expect(verdict('search.p95')).toBe('over');
    expect(verdict('live.idle')).toBe('failed');
    expect(verdict('web.js')).toBe('failed');
    expect(verdict('import.time')).toBe('ok');
    expect(judge('150k', results).find((r) => r.budget.key === 'demo.time')!.verdict).toBe('none');
    const text = report('50k', rows);
    expect(text).toContain('search p95');
    expect(text).toContain('Brain frame rate');
    expect(text.trim().split('\n').at(-1)).toBe('3 of 16 measures over budget or failed at 50k: search p95; Live idle memory; Web initial JS (gzip).');
    expect(text).not.toMatch(/[─-╿\u001b]/); // no box drawing, no escapes
  });

  it('takes the MCP p95 over the lookups only, and the slowest ask apart', () => {
    const tools = ['list_hubs', 'search', 'ask', 'timeline', 'ask', 'read_hub'];
    const r = { times: [10, 20, 900, 30, 1_500, 40], sizes: [100, 200, 2_048, 300, 400, 500], out: [], peakMB: 0, tools };
    expect(mcpResults(r)).toEqual({
      'mcp.p95': { value: 40, note: '4 calls' },
      'mcp.ask': { value: 1_500, note: 'the slowest of 2' },
      'mcp.size': { value: 2 },
    });
    expect(() => mcpResults({ ...r, tools: tools.map(() => 'search') })).toThrow(/No MCP ask/);
  });

  it('takes the nearest-rank percentile', () => {
    expect(percentile(Array.from({ length: 20 }, (_, i) => 20 - i), 95)).toBe(19);
    expect(percentile([7], 95)).toBe(7);
    expect(() => percentile([], 95)).toThrow();
  });
});

describe('bench runner', () => {
  it('takes one size and keeps its folder inside the checkout by default', () => {
    expect(parseOptions([]).size).toBe('50k');
    expect(parseOptions(['150k', '--keep'])).toMatchObject({ size: '150k', keep: true, seed: 42, entries: 150_000 });
    expect(parseOptions(['--entries', '3000']).entries).toBe(3_000);
    expect(() => parseOptions(['--entries', '10'])).toThrow(/1000 or more/);
    expect(parseOptions([]).dir).toMatch(/[/\\]\.skeinwise[/\\]bench[/\\]50k$/);
    expect(() => parseOptions(['1m'])).toThrow(/50k or 150k/);
  });

  it('stops a worker that runs past its time and says when', async () => {
    const corpus = writeCorpus(join(dir, 'corpus'), 3_000);
    const env = { ...process.env, SKEINWISE_HOME: join(dir, 'home'), HOME: join(dir, 'user') };
    const stopped = await runWorker({ kind: 'cli', runs: [['import', ...corpus.paths]] }, env, 50).catch((err: unknown) => err);
    expect(stopped).toBeInstanceOf(Stopped);
    expect((stopped as Stopped).after).toBe(50);
    expect((stopped as Stopped).message).toBe('stopped after 50 ms');
  });

  it('clears only a folder it made, or an empty one', () => {
    const theirs = join(dir, 'theirs');
    mkdirSync(theirs);
    writeFileSync(join(theirs, 'keep-me.txt'), 'not the bench’s');
    expect(() => prepare(theirs)).toThrow(/didn't make it/);
    expect(readFileSync(join(theirs, 'keep-me.txt'), 'utf8')).toBe('not the bench’s');
    const ours = join(dir, 'ours');
    prepare(ours);
    writeFileSync(join(ours, 'old-run.txt'), 'x');
    prepare(ours);
    expect(readdirSync(ours)).toEqual(['.skeinwise-bench']);
  });

  it("counts the built page's module script and preloads, not its styles", () => {
    expect(webInitialJs(join(dir, 'nowhere'))).toEqual({ error: 'no dist/web: run pnpm build first' });
    const web = join(dir, 'web');
    mkdirSync(join(web, 'assets'), { recursive: true });
    writeFileSync(join(web, 'assets', 'index.js'), 'console.log(1);'.repeat(100));
    writeFileSync(join(web, 'assets', 'vendor.js'), 'console.log(2);'.repeat(100));
    writeFileSync(join(web, 'assets', 'index.css'), 'body{}'.repeat(10_000));
    writeFileSync(
      join(web, 'index.html'),
      '<script type="module" crossorigin src="/assets/index.js"></script><link rel="modulepreload" crossorigin href="/assets/vendor.js"><link rel="stylesheet" href="/assets/index.css">',
    );
    const r = webInitialJs(web);
    expect(r).toMatchObject({ note: '2 files' });
    expect((r as { value: number }).value).toBeLessThan(0.2);
  });
});
