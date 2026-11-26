// A note's front-matter tags used to land only in its properties, while `skeinwise tags`, the web's grouping and every
// other view read the tag tables. The Topics run now takes them as written, under its own run, with or without a model.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { DEMO_NOW, writeDemo } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { createModel } from '../src/organiser/model.ts';
import { type RunOptions, runTask } from '../src/organiser/organise.ts';
import { RecordView } from '../src/organiser/record.ts';
import { undoRun } from '../src/organiser/runs.ts';
import { frontMatterTagNames } from '../src/organiser/tags.ts';
import { findSchema, liveTags } from '../src/organiser/views.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

const NONE: Omit<RunOptions, 'task'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };

/** Topics' live tags as lower-cased name (tags match by name in any case) → the entries they tag, sorted. */
function topics(store: Store): Map<string, string[]> {
  const schema = findSchema(store.db, 'Topics')!;
  const ext = new Map(store.allEntries().map((e) => [e.id, e.externalId]));
  return new Map(liveTags(store.db, schema.id).map((t) => [t.name.toLowerCase(), t.entryIds.map((id) => ext.get(id)!).sort()]));
}

const tagTopics = (store: Store, options: Partial<RunOptions> = {}) =>
  runTask(store, new RecordView(store), { ...NONE, task: 'tag', schema: findSchema(store.db, 'Topics')!, ...options });

describe('front-matter tags', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-fm-tags-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, front: string, body: string) =>
    writeFileSync(join(dir, name), `${front ? `---\n${front}\n---\n\n` : ''}# ${name.replace(/\.md$/, '')}\n\n${body}\n`);
  const capture = (store: Store) => {
    for (const b of readImports(dir)) store.ingest(b, 'you');
  };

  it('become Topics tags in one run without a model, under that run, and go when it is undone', async () => {
    write('sowing.md', 'tags: [Garden, beds]', 'Sow the peas in rows along the fence.');
    write('heap.md', 'tags: "#garden, compost"', 'Turn the heap each fortnight.');
    write('soup.md', 'tags:\ntag: kitchen', 'Leek and potato, a little thyme.');
    write('plain.md', '', 'Nothing tagged here at all.');
    const store = new Store(openDb(':memory:'));
    capture(store);

    const run = await tagTopics(store);
    const shown = topics(store);
    // One tag for both notes, named as the first of them writes it.
    expect(shown.get('garden')).toEqual(['heap.md', 'sowing.md']);
    expect(shown.get('beds')).toEqual(['sowing.md']);
    expect(shown.get('compost')).toEqual(['heap.md']);
    // A blank `tags:` line no longer hides the older `tag:` key.
    expect(shown.get('kitchen')).toEqual(['soup.md']);
    for (const name of ['garden', 'beds', 'compost', 'kitchen']) expect(shown.get(name)).not.toContain('plain.md');
    const rows = store.db
      .prepare("SELECT DISTINCT et.run_id AS runId FROM entry_tags et JOIN tags t ON t.id = et.tag_id WHERE lower(t.name) IN ('garden', 'beds', 'compost', 'kitchen')")
      .all() as { runId: number }[];
    expect(rows).toEqual([{ runId: run.id }]);

    undoRun(store.db, run.id);
    expect(topics(store).size).toBe(0);
  });

  it('follow a front-matter-only edit in a run over new versions', async () => {
    write('sowing.md', 'tags: [garden]', 'Sow the peas in rows along the fence.');
    const store = new Store(openDb(':memory:'));
    capture(store);
    await tagTopics(store);
    write('sowing.md', 'tags: [garden, peas]', 'Sow the peas in rows along the fence.');
    capture(store);

    await tagTopics(store, { scope: { kind: 'new' } });
    expect(topics(store).get('peas')).toEqual(['sowing.md']);
  });
});

describe('front-matter tags on the demo record', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-fm-demo-'));
    writeDemo(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function demo(): { store: Store; given: Map<string, string[]> } {
    const store = new Store(openDb(':memory:'), () => DEMO_NOW);
    for (const p of ['chatgpt', 'claude', 'claude-code', 'notes']) for (const b of readImports(join(dir, p))) store.ingest(b);
    const given = new Map<string, string[]>();
    for (const e of store.allEntries()) {
      const properties = store.history(e.id).at(-1)!.properties;
      for (const name of properties ? frontMatterTagNames(properties) : []) {
        const key = name.toLowerCase();
        given.set(key, [...(given.get(key) ?? []), e.externalId].sort());
      }
    }
    expect(given.get('plotline')?.length).toBeGreaterThan(1);
    return { store, given };
  }

  it('show on every tagged note after one run without a model', async () => {
    const { store, given } = demo();
    await tagTopics(store);
    const shown = topics(store);
    // A topic the words name alike (say "Rust") is one tag with the notes' own: each note is in it.
    for (const [name, notes] of given) expect(shown.get(name), name).toEqual(expect.arrayContaining(notes));
  });

  it('show exactly as given after one run with a model, which names only the groups', async () => {
    const { store, given } = demo();
    let asked = 0;
    const standIn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'stand-in' }] });
      const user = (JSON.parse(String(init!.body)) as { messages: { content: string }[] }).messages[1]!.content;
      asked++;
      const names = [...user.matchAll(/^G(\d+):/gm)].map((m) => ({ group: `G${m[1]}`, name: `Group ${m[1]}` }));
      return Response.json({ choices: [{ message: { content: JSON.stringify({ names }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
    }) as typeof globalThis.fetch;

    await tagTopics(store, { engine: 'local', yes: true, client: createModel(DEFAULT_CONFIG, 'local', { fetch: standIn, env: {} }) });
    expect(asked).toBe(1);
    const shown = topics(store);
    for (const [name, notes] of given) expect(shown.get(name), name).toEqual(notes);
    expect([...shown.keys()].filter((n) => !given.has(n)).every((n) => /^group \d+$/.test(n))).toBe(true);
  });
});

describe('frontMatterTagNames', () => {
  it('reads a list item by item and a line at commas and spaces, as written', () => {
    expect(frontMatterTagNames({ tags: ['Garden', '#beds', ' garden ', ''] })).toEqual(['Garden', 'beds']);
    expect(frontMatterTagNames({ Tags: '#one, two three' })).toEqual(['one', 'two', 'three']);
  });

  it('takes `tag` when `tags` names none', () => {
    expect(frontMatterTagNames({ tags: '', tag: 'kitchen' })).toEqual(['kitchen']);
    expect(frontMatterTagNames({ tags: [], TAG: ['a'] })).toEqual(['a']);
    expect(frontMatterTagNames({ tags: 'x', tag: 'y' })).toEqual(['x']);
    expect(frontMatterTagNames({ title: 'No tags' })).toEqual([]);
  });

  it('drops controls and a name longer than a topic may be', () => {
    expect(frontMatterTagNames({ tags: ['\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007', 'x'.repeat(61), 'ok'] })).toEqual(['link', 'ok']);
  });
});
