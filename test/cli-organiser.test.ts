import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { DEMO_NOW } from '../src/demo/demo.ts';

// The organiser's commands, run the way a person runs them: through main() with a record folder of their own.

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

function newHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'skeinwise-organiser-cli-'));
  roots.push(root);
  return join(root, 'home');
}

interface Opts {
  fetch?: typeof globalThis.fetch;
  now?: string;
}

/** A skeinwise command bound to one record folder. */
function inHome(home: string, opts: Opts = {}) {
  return async (...argv: string[]) => {
    let out = '';
    let err = '';
    const code = await main(argv, {
      out: (t) => (out += t),
      err: (t) => (err += t),
      env: { SKEINWISE_HOME: home },
      now: () => opts.now ?? DEMO_NOW,
      fetch: opts.fetch ?? noNetwork,
    });
    return { code, out, err };
  };
}

/** The network for commands that must not use it. */
const noNetwork = (async (input: string | URL | Request) => {
  throw new Error(`No network in this test, but something fetched ${String(input)}`);
}) as typeof globalThis.fetch;

function parsed<T>(r: { code: number; out: string; err: string }): T {
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as T;
}

interface RunJson {
  id: number;
  task: string;
  engine: string;
  status: string;
  tokensIn: number;
  tokensOut: number;
}
interface HubJson {
  id: number;
  name: string;
}
interface FolderJson {
  id: number;
  name: string;
  entryIds: number[];
}

describe('organising the demo record from the command line', () => {
  const home = newHome();
  const sw = inHome(home);
  let ran: { code: number; out: string; err: string };
  let runIds: Record<string, number>;
  let plotline: HubJson;

  beforeAll(async () => {
    expect((await sw('demo')).code).toBe(0);
    ran = await sw('run', 'all', '--engine', 'none');
    const runs = parsed<RunJson[]>(await sw('runs', '--json'));
    runIds = Object.fromEntries(runs.map((r) => [r.task, r.id]));
    plotline = parsed<HubJson[]>(await sw('hubs', '--json')).find((h) => /Plotline/.test(h.name))!;
  });

  it('run all prints each run as it finishes and makes hubs for Plotline, sourdough and the river thesis', async () => {
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('Run 1: tag Topics · No-AI · scope all · done');
    expect(ran.out).toMatch(/Run 6: hub · No-AI · scope all · done · .*hubs 8/);
    expect(ran.out).toContain('Undo a run with: skeinwise undo <run>');
    const runs = parsed<RunJson[]>(await sw('runs', '--json'));
    expect(runs.map((r) => r.task).reverse()).toEqual(['tag', 'tag', 'tag', 'file', 'link', 'hub', 'layer', 'review']);
    expect(runs.every((r) => r.engine === 'none' && r.status === 'done' && r.tokensIn === 0)).toBe(true);
    const names = parsed<HubJson[]>(await sw('hubs', '--json')).map((h) => h.name);
    expect(names.some((n) => /Plotline/.test(n))).toBe(true);
    expect(names.some((n) => /sourdough/i.test(n))).toBe(true);
    expect(names.some((n) => /nitrate|samples|river|thesis/i.test(n))).toBe(true);
    expect((await sw('runs')).out).toMatch(/^2026-11-20 18:00 {2}Run 8: review · No-AI/m);
  });

  it('hub shows its three sections, cited by entry and date, then its entries', async () => {
    const r = await sw('hub', String(plotline.id), '--limit', '5');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`^${plotline.name}\\nHub ${plotline.id} · \\d+ entries · made by run ${runIds.hub}\\n`));
    for (const section of ['In short', 'What you found', 'Open ends', 'Entries:']) expect(r.out).toContain(`\n${section}\n`);
    expect(r.out).toContain('  - Decided: Plotline runs on SQLite.  (#385, 2025-03-09)');
    expect(r.out).toMatch(/… and \d+ more \(--limit \d+ shows them all\)\n$/);
    const missing = await sw('hub', '999');
    expect(missing).toMatchObject({ code: 2, out: '' });
    expect(missing.err).toContain('No hub 999.');
  });

  it('ask "what did I decide about sqlite" gives both Plotline decisions, oldest first', async () => {
    const answer = parsed<{ kind: string; hits: { entryId: number; why: string }[] }>(
      await sw('ask', 'what did I decide about sqlite', '--engine', 'none', '--json'),
    );
    expect(answer.kind).toBe('decided');
    expect(answer.hits.map((h) => h.entryId)).toEqual([385, 345]);
    const text = (await sw('ask', 'what', 'did', 'I', 'decide', 'about', 'sqlite', '--engine', 'none')).out;
    expect(text).toMatch(/^What you decided about "sqlite", oldest first:\n#385 {2}2025-03-09 {2}you · Plotline runs on SQLite {2}\[decision\]\n/);
    expect(text.indexOf('#345')).toBeGreaterThan(text.indexOf('#385'));
    expect((await sw('ask', '--engine', 'none')).code).toBe(2);
  });

  it('similar lists entries from other threads that read alike', async () => {
    const r = await sw('similar', '385');
    expect(r.out).toMatch(/^Entries in other threads that read like #385 {2}2025-03-09 {2}you · Plotline runs on SQLite:\n#345 /);
  });

  it('review flags the Plotline note after the April 2026 move to Postgres, and saves an update only with --yes', async () => {
    const items = parsed<{ id: number; noteEntry: number; reasons: { entryId: number }[] }[]>(await sw('review', '--json'));
    const item = items.find((i) => i.noteEntry === 420)!;
    expect(item.reasons.map((r) => r.entryId)).toEqual([385, 345]);
    expect((await sw('review')).out).toContain(`Item ${item.id}: #420  2025-02-05  you · Plotline may be out of date. Later entries:`);

    const shown = await sw('review', '--resolve', String(item.id), 'update');
    expect(shown.out).toContain('Note #420, as the update would change it:\n');
    expect(shown.out).toContain('+ ## Updates');
    expect(shown.out).toContain(`Nothing is saved yet. Save it with: skeinwise review --resolve ${item.id} update --yes`);
    expect((await sw('history', '420')).out.trim().split('\n')).toHaveLength(1);

    const saved = await sw('review', '--resolve', String(item.id), 'update', '--yes');
    expect(saved.out).toContain('Saved note #420 as version 2. The text before stays in its history: skeinwise history 420');
    expect((await sw('history', '420')).out).toMatch(/^v2 {2}2026-11-20 18:00 {2}by you /m);
    expect(parsed<{ id: number }[]>(await sw('review', '--json')).map((i) => i.id)).not.toContain(item.id);

    const wrong = await sw('review', '--resolve', String(items[0]!.id), 'maybe');
    expect(wrong.code).toBe(2);
    expect(wrong.err).toContain('Answer with update, holds or skip');
  });

  it('links shows the five kinds of line, in all and for one entry', async () => {
    const all = (await sw('links')).out;
    for (const kind of ['thread line', 'cross link', 'note link', 'hub spoke', 'time chain']) expect(all).toMatch(new RegExp(`  ${kind} +\\d+  `));
    const one = (await sw('links', '345')).out;
    expect(one).toContain('  thread line after  #346');
    expect(one).toMatch(/ {2}cross link +0\.\d\d #385 /);
    expect(one).toContain(`  hub spoke   hub ${plotline.id}: ${plotline.name}`);
    expect(one).toContain('  time chain  before #412');
  });

  it('layers shows the original beside the layers a run made, and says what makes a missing one', async () => {
    const r = await sw('layers', '18');
    expect(r.out).toContain('\nOriginal\n    The three changes:');
    expect(r.out).toContain(`\nIdeas  (No-AI, run ${runIds.layer})\n    - The three changes:`);
    const expanded = await sw('layers', '18', '--layer', 'expanded');
    expect(expanded.code).toBe(2);
    expect(expanded.err).toContain('Entry 18 has no Expanded layer yet. Only a model writes Expanded: skeinwise run layer --engine local');
    expect((await sw('layers', '18', '--layer', 'bogus')).code).toBe(2);
  });

  it('tags lists each schema, and --schema one in full', async () => {
    const all = (await sw('tags')).out;
    for (const s of ['Topics:', 'Projects:', 'Moods:']) expect(all).toContain(s);
    expect(all).toMatch(/^ {2}Plotline +\d+$/m);
    expect((await sw('tags', '--schema', 'moods')).out).toMatch(/^Moods: How you sound/);
    expect((await sw('tags', '--schema', 'Nope')).code).toBe(2);
  });

  it('merge-folders is a run you can undo', async () => {
    const before = parsed<FolderJson[]>(await sw('folders', '--json'));
    const [into, from] = before.filter((f) => f.name !== 'Inbox');
    const merged = await sw('merge-folders', from!.name, String(into!.id));
    const runId = Number(/Undo with: skeinwise undo (\d+)/.exec(merged.out)![1]);
    const after = parsed<FolderJson[]>(await sw('folders', '--json'));
    expect(after.map((f) => f.id)).not.toContain(from!.id);
    expect((await sw('folders')).out).toContain(`also: ${from!.name}`);
    expect((await sw('undo', String(runId))).out).toMatch(new RegExp(`^Undid run ${runId}, your correction: `));
    expect(parsed<FolderJson[]>(await sw('folders', '--json'))).toEqual(before);
    expect((await sw('merge-folders', from!.name)).code).toBe(2);
  });

  it('rename-hub and delete-hub are undone in the reverse order they were made', async () => {
    const id = String(plotline.id);
    const renamed = Number(/undo (\d+)/.exec((await sw('rename-hub', id, 'The', 'allotment', 'app')).out)![1]);
    expect((await sw('hub', id)).out).toMatch(/^The allotment app\n/);
    const deleted = Number(/undo (\d+)/.exec((await sw('delete-hub', id)).out)![1]);
    expect((await sw('hub', id)).code).toBe(2);
    const early = await sw('undo', String(renamed));
    expect(early.code).toBe(2);
    expect(early.err).toContain(`Run ${deleted} changed the same thing later. Undo that first.`);
    expect((await sw('undo', String(deleted))).code).toBe(0);
    expect((await sw('undo', String(renamed))).code).toBe(0);
    expect((await sw('hub', id)).out).toMatch(new RegExp(`^${plotline.name}\\n`));
  });

  it('define-tag makes a schema of your own; a tag a run used is removed only after that run is undone', async () => {
    expect((await sw('define-tag', 'Kitchen', 'bread', 'sourdough', 'rye', 'loaf', 'starter')).out).toBe(
      'Made the schema Kitchen with the tag "bread".\nTag your entries with it: skeinwise run tag --schema Kitchen\n',
    );
    const tagged = await sw('run', 'tag', '--schema', 'Kitchen', '--engine', 'none');
    const runId = Number(/^Run (\d+): tag Kitchen/.exec(tagged.out)![1]);
    expect((await sw('tags', '--schema', 'Kitchen')).out).toMatch(/^ {2}bread +\d+/m);
    const refused = await sw('define-tag', 'Kitchen', 'bread', '--remove');
    expect(refused.code).toBe(2);
    expect(refused.err).toContain(`Runs ${runId} tagged entries "bread"`);
    await sw('undo', String(runId));
    expect((await sw('define-tag', 'Kitchen', 'bread', '--remove')).out).toBe('Removed "bread" from Kitchen.\n');
  });

  it('undo takes away what a run made and leaves your entries as they were', async () => {
    const before = (await sw('show', '18')).out;
    const r = await sw('undo', String(runIds.layer));
    expect(r.out).toBe(`Undid run ${runIds.layer} (layer). Removed 12 layers.\n`);
    expect((await sw('layers', '18')).out).toContain('No layers yet. Make them with: skeinwise run layer');
    expect((await sw('show', '18')).out).toBe(before);
    const again = await sw('undo', String(runIds.layer));
    expect(again.code).toBe(2);
    expect(again.err).toContain('is already undone');
  });
});

describe('notes from the command line', () => {
  it('note and new-note write files in the record folder, and an editor edit is read on the next question', async () => {
    const home = newHome();
    const sw = inHome(home, { now: '2026-11-25T10:30:00.000Z' });
    const first = await sw('note', 'Fed the starter at 18:00');
    expect(first.out).toMatch(/^Started .*daily\/2026-11-25\.md \(entry #1\)\.\n$/);
    expect((await sw('note', 'Rye proof took four hours')).out).toMatch(/^Added to .*2026-11-25\.md \(entry #1\)\.\n$/);
    expect((await sw('note')).code).toBe(2);

    const made = parsed<{ path: string; entryId: number }>(await sw('new-note', 'Garden plan', '--json'));
    expect(readFileSync(made.path, 'utf8')).toContain('# Garden plan\n');
    appendFileSync(made.path, '\nBeds first, then the paths.\n');
    const asked = await sw('ask', 'where did I write about beds', '--engine', 'none');
    expect(asked.out).toContain(`#${made.entryId}`);
    expect((await sw('history', String(made.entryId))).out).toMatch(/^v2 .* by you /m);
  });
});

describe('settings from the command line', () => {
  it('config lists, sets, checks and resets each setting', async () => {
    const sw = inHome(newHome());
    const listed = (await sw('config')).out;
    expect(listed).toMatch(/^Settings \(.*config\.json\):\n/);
    expect(listed).toMatch(/^ {2}engine +local$/m);
    expect((await sw('config', 'engine', 'none')).out).toBe('engine = none\n');
    expect((await sw('config')).out).toMatch(/^ {2}engine +none {2}\(changed\)$/m);
    expect((await sw('config', 'engine')).out).toBe('none\n');
    expect((await sw('config', 'budget', 'lots')).code).toBe(2);
    expect((await sw('config', 'engine', '--unset')).out).toBe('engine is back to its default: local\n');
    expect((await sw('config', 'liveFolders', '[{"path": "/notes/mara", "owner": "Mara"}, {"path": "/notes/mine"}]')).out).toBe(
      'liveFolders = /notes/mara (Mara), /notes/mine\n',
    );
    const unknown = await sw('config', 'colour', 'blue');
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('Unknown setting "colour"');
    expect((await sw('run', 'hub', '--engine', 'cloud')).code).toBe(2);
  });
});

describe('a model engine from the command line', () => {
  const home = newHome();
  beforeAll(async () => {
    expect((await inHome(home)('demo')).code).toBe(0);
  });

  it('a local server that is down stops the run with how to start one, and saves nothing', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const sw = inHome(home, { fetch: down });
    for (const argv of [['run', 'hub'], ['ask', 'what did I decide about sqlite']]) {
      const r = await sw(...argv);
      expect(r.code).toBe(2);
      expect(r.err).toContain('No model server answers at http://127.0.0.1:8731/v1.');
      expect(r.err).toContain('llama-server -m <model>.gguf --port 8731 --jinja');
      expect(r.err).toContain('--engine none');
    }
    expect(parsed<unknown[]>(await sw('runs', '--json'))).toEqual([]);
  });

  it('--preview shows each request a run would send, and sends and saves nothing', async () => {
    const sw = inHome(home);
    const r = await sw('run', 'all', '--preview');
    expect(r.code).toBe(0);
    expect(r.out).toContain('--- request 1 of');
    expect(r.out).toContain('[system]\n');
    expect(r.out).toMatch(/Nothing was sent or saved\. About \d+ tokens in all\.\n$/);
    const none = (await sw('run', 'hub', '--preview', '--engine', 'none')).out;
    expect(none).toContain('Nothing goes to a model: the No-AI engine works on this computer.');
    expect(parsed<unknown[]>(await sw('runs', '--json'))).toEqual([]);
  });

  it('ask with a local model prints its answer and the entries it cites, and records the tokens', async () => {
    const fake = (async (input: string | URL | Request) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'models/fake-4b.gguf' }] });
      const content = JSON.stringify({ answer: 'SQLite in March 2025, then Postgres in April 2026.', cites: ['E1', 'E2'] });
      return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 25 } });
    }) as typeof globalThis.fetch;
    const sw = inHome(home, { fetch: fake });
    const r = await sw('ask', 'what did I decide about sqlite');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^SQLite in March 2025, then Postgres in April 2026\.\n {4}\(local model models\/fake-4b\.gguf, citing #385, #345\)\n/);
    const [run] = parsed<RunJson[]>(await sw('runs', '--json'));
    expect(run).toMatchObject({ task: 'ask', engine: 'local', status: 'done', tokensIn: 300, tokensOut: 25 });
    expect((await sw('undo', String(run!.id))).code).toBe(2);
  });

  it("sends the locked local server the key from the record folder's models/.key", async () => {
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(join(home, 'models', '.key'), 'local-server-key-for-this-test\n', { mode: 0o600 });
    const sent: (string | null)[] = [];
    const locked = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('authorization'));
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'models/fake-4b.gguf' }] });
      const content = JSON.stringify({ answer: 'SQLite first.', cites: ['E1'] });
      return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    }) as typeof globalThis.fetch;
    try {
      const r = await inHome(home, { fetch: locked })('ask', 'what did I decide about sqlite');
      expect(r.code).toBe(0);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((h) => h === 'Bearer local-server-key-for-this-test')).toBe(true);
    } finally {
      rmSync(join(home, 'models'), { recursive: true, force: true });
    }
  });
});
