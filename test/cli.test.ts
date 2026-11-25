import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { buildThreads, DEMO_NOW, writeDemo } from '../src/demo/demo.ts';

let dir: string;

interface Call {
  home?: string;
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string>;
}

async function call(opts: Call, ...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    out: (t) => (out += t),
    err: (t) => (err += t),
    env: { SKEINWISE_HOME: opts.home ?? join(dir, 'home'), ...opts.env },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return { code, out, err };
}

function cli(...argv: string[]) {
  return call({}, ...argv);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the skeinwise command', () => {
  it('prints help and version', async () => {
    expect((await cli('help')).out).toContain('Usage: skeinwise');
    expect((await cli('version')).out).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(JSON.parse((await cli('version', '--json')).out)).toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  });

  it('creates an owner-only record folder', async () => {
    expect(JSON.parse((await cli('init', '--json')).out)).toEqual({ home: join(dir, 'home') });
    expect(statSync(join(dir, 'home')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'home', 'record.db')).isFile()).toBe(true);
  });

  it('imports, searches, shows and re-imports without duplicates', async () => {
    const notes = join(dir, 'vault');
    mkdirSync(notes);
    writeFileSync(join(notes, 'bread.md'), '---\ntitle: Bread\ncreated: 2025-01-02\n---\nThe rye loaf needs a long proof. #baking');
    writeFileSync(join(notes, '2025-01-03.md'), 'Baked the rye loaf for the market.');

    const first = await cli('import', notes, '--json');
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toEqual([expect.objectContaining({ kind: 'notes', added: 2 })]);
    expect((await cli('import', notes)).out).toContain('0 new, 0 changed, 2 already in');

    const search = await cli('search', 'rye', 'loaf');
    expect(search.out).toMatch(/#\d+ {2}2025-01-0\d {2}you · vault/);
    expect(search.out).toContain('[rye] [loaf]');

    const hits = JSON.parse((await cli('search', 'rye', '--json', '--limit', '1')).out) as { id: number }[];
    expect(hits).toHaveLength(1);
    const show = await cli('show', String(hits[0]!.id));
    expect(show.out).toMatch(/rye loaf/);
    expect((await cli('history', String(hits[0]!.id))).out).toMatch(/^v1 .* by import/);

    expect((await cli('stats')).out).toContain('Woven from 2 entries');
    expect((await cli('sources')).out).toMatch(/1 {2}in {4}vault \(notes\): 2 entries/);
    expect(JSON.parse((await cli('exclude', '1', '--json')).out)).toEqual({ source: 1, status: 'out' });
    expect((await cli('search', 'rye')).out).toContain('Nothing found');
    expect((await cli('include', '1')).code).toBe(0);
    expect((await cli('search', 'rye')).out).toContain('[rye]');
  });

  it('keeps someone else’s notes under their name', async () => {
    const notes = join(dir, 'mara');
    mkdirSync(notes);
    writeFileSync(join(notes, 'route.md'), 'Split the ride at the reservoir.');
    await cli('import', notes, '--owner', 'Mara');
    expect((await cli('search', 'reservoir', '--speaker', 'Mara')).out).toContain('Mara · mara');
    expect((await cli('search', 'reservoir', '--speaker', 'you')).out).toContain('Nothing found');
  });

  it('fails loudly with usage errors', async () => {
    expect(await cli('nope')).toMatchObject({ code: 2, err: expect.stringContaining('Unknown command: nope') });
    expect(await cli('show')).toMatchObject({ code: 2, err: expect.stringContaining('entry number') });
    expect(await cli('show', '99')).toMatchObject({ code: 2, err: expect.stringContaining('No entry 99') });
    expect(await cli('import')).toMatchObject({ code: 2 });
    expect(await cli('search')).toMatchObject({ code: 2 });
    expect(await cli('import', join(dir, 'missing'))).toMatchObject({ code: 1, err: expect.stringContaining('ENOENT') });
    expect((await cli('search', 'x', '--bogus')).code).toBe(1);
  });
});

describe('the demo record', () => {
  it('is the same for the same seed and never dated after the demo’s today', () => {
    const a = buildThreads(7);
    expect(buildThreads(7)).toEqual(a);
    expect(buildThreads(8)).not.toEqual(a);
    for (const t of a) for (const m of t.messages) expect(m.at.getTime()).toBeLessThanOrEqual(Date.parse(DEMO_NOW) + 3600_000);
  });

  it('writes files the importers read', () => {
    const summary = writeDemo(join(dir, 'exports'));
    expect(summary.files).toEqual(expect.arrayContaining(['chatgpt/conversations.json', 'claude/conversations.json']));
    const claude = JSON.parse(readFileSync(join(dir, 'exports', 'claude', 'conversations.json'), 'utf8')) as unknown[];
    expect(claude.length).toBeGreaterThan(10);
  });

  it('builds a searchable record and refuses to mix with a real one', async () => {
    const run = await cli('demo', '--json');
    expect(run.code).toBe(0);
    const result = JSON.parse(run.out) as { threads: number; results: { source: string; added: number }[] };
    expect(result.results.map((r) => r.source)).toEqual(['ChatGPT', 'Claude', 'Claude Code', 'notes']);
    expect(result.results.every((r) => r.added > 0)).toBe(true);

    const decisions = (await cli('search', 'what did I decide about sqlite', '--limit', '3')).out;
    expect(decisions).toContain('Plotline runs on [SQLite]');
    expect(decisions).toContain('Changing my mind on [SQLite]');

    expect(await cli('demo')).toMatchObject({ code: 2, err: expect.stringContaining('is not empty') });
    expect((await cli('demo', '--force')).code).toBe(0);
  });
});
