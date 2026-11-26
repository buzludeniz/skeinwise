// Projects come from notes linked from two or more entries. A record that links freely made most of its notes projects
// (3,956 tags on the 50,000-entry bench, 722 of them daily notes), so a daily note is never one, and only the
// PROJECT_MAX most linked notes are kept, the note that came into the record first on a tie.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { DEMO_NOW } from '../src/demo/demo.ts';
import { readImports } from '../src/importers/detect.ts';
import { tagAsAgent } from '../src/mcp/tags.ts';
import { type RunOptions, runTask } from '../src/organiser/organise.ts';
import { isDailyNote, linkTargets, RecordView } from '../src/organiser/record.ts';
import { currentMark, finishRun, startRun } from '../src/organiser/runs.ts';
import { PROJECT_MAX } from '../src/organiser/tags.ts';
import { definedTags, findSchema, liveTags } from '../src/organiser/views.ts';
import { openDb } from '../src/store/db.ts';
import { type Entry, Store } from '../src/store/store.ts';

const NONE: Omit<RunOptions, 'task'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };

/** Writes notes, each under its path in `dir` and headed by its title. */
function writeNotes(dir: string, files: Record<string, { title: string; body: string }>): void {
  for (const [path, { title, body }] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `# ${title}\n\n${body}\n`);
  }
}

/**
 * PROJECT_MAX + 5 notes "Plan 1" onwards, all linked from "Hub A" and "Hub B". Every plan ties on two links, so the
 * cap keeps the ones that came in first.
 */
function plans(): Record<string, { title: string; body: string }> {
  const names = Array.from({ length: PROJECT_MAX + 5 }, (_, i) => `Plan ${i + 1}`);
  const links = names.map((n) => `[[${n}]]`).join(', ');
  return {
    ...Object.fromEntries(names.map((n) => [`${n}.md`, { title: n, body: 'Steps and dates.' }])),
    'Hub A.md': { title: 'Hub A', body: `Every plan: ${links}.` },
    'Hub B.md': { title: 'Hub B', body: `The same plans again: ${links}.` },
  };
}

/** The Projects tags the newest Projects run made, in the order it made them. */
function lastRunTags(db: Store['db']): string[] {
  const projects = findSchema(db, 'Projects')!;
  return (
    db
      .prepare(
        `SELECT name FROM tags WHERE schema_id = ? AND run_id = (SELECT MAX(id) FROM runs WHERE task = 'tag' AND schema_id = ? AND status = 'done')
         ORDER BY id`,
      )
      .all(projects.id, projects.id) as { name: string }[]
  ).map((r) => r.name);
}

/** The plans the cap keeps, in note order: all of them tie on links unless `extra` has one more. */
function expectedPlans(entries: Entry[], extra?: Entry): string[] {
  const all = entries.filter((e) => /^Plan \d+$/.test(e.title ?? '')).sort((a, b) => a.id - b.id);
  const rest = all.filter((e) => e !== extra).slice(0, extra ? PROJECT_MAX - 1 : PROJECT_MAX);
  return [...rest, ...(extra ? [extra] : [])].sort((a, b) => a.id - b.id).map((e) => e.title!);
}

describe('which notes are projects', () => {
  let dir: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-projects-cap-'));
    store = new Store(openDb(':memory:'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const ingest = (folder: string) => {
    for (const b of readImports(folder)) store.ingest(b, 'you');
  };
  const runProjects = () => runTask(store, new RecordView(store), { ...NONE, task: 'tag', schema: findSchema(store.db, 'Projects')! });
  const projectNames = () => liveTags(store.db, findSchema(store.db, 'Projects')!.id).map((t) => t.name).sort();

  it('a daily note is never a project, however many entries link to it', async () => {
    writeNotes(dir, {
      'daily/Week one.md': { title: 'Week one', body: 'Logged the week.' },
      '2026-11-02.md': { title: '2026-11-02', body: 'Rain all day.' },
      'Garden plan.md': { title: 'Garden plan', body: 'Beds, paths and the shed.' },
      'Monday.md': { title: 'Monday', body: 'See [[Week one]], [[2026-11-02]] and [[Garden plan]].' },
      'Tuesday.md': { title: 'Tuesday', body: 'Again [[Week one]], [[2026-11-02]] and [[Garden plan]].' },
      'Wednesday.md': { title: 'Wednesday', body: 'Still [[Week one]], [[2026-11-02]] and [[Garden plan]].' },
    });
    ingest(dir);
    const daily = new RecordView(store).entries.filter(isDailyNote).map((e) => e.title).sort();
    expect(daily).toEqual(['2026-11-02', 'Week one']);
    await runProjects();
    expect(projectNames()).toEqual(['Garden plan']);
  });

  it(`keeps the ${PROJECT_MAX} most linked notes, the one that came in first on a tie, in note order`, async () => {
    writeNotes(join(dir, 'plans'), plans());
    ingest(join(dir, 'plans'));
    await runProjects();
    const tied = expectedPlans(store.allEntries());
    expect(lastRunTags(store.db)).toEqual(tied);

    // A third link lifts the plan that came in last above every tie, and the last of the tied ones makes way for it.
    const last = store.allEntries().filter((e) => /^Plan \d+$/.test(e.title ?? '')).sort((a, b) => b.id - a.id)[0]!;
    writeNotes(join(dir, 'more'), { 'Hub C.md': { title: 'Hub C', body: `Only [[${last.title}]].` } });
    ingest(join(dir, 'more'));
    await runProjects();
    const lifted = expectedPlans(store.allEntries(), last);
    expect(lifted).toContain(last.title);
    expect(lifted).not.toContain(tied.at(-1));
    expect(lastRunTags(store.db)).toEqual(lifted);
    expect(projectNames()).toEqual([...lifted].sort());
  });
});

describe('a record organised under the old rule, run through run all', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const d of roots) rmSync(d, { recursive: true, force: true });
  });

  /** A skeinwise command on its own record folder, run as a person runs it. A command that fails fails the test. */
  function inHome(home: string) {
    return async (...argv: string[]) => {
      let err = '';
      const code = await main(argv, {
        out: () => {},
        err: (t) => (err += t),
        env: { SKEINWISE_HOME: home },
        now: () => DEMO_NOW,
        fetch: (async (input: string | URL | Request) => {
          throw new Error(`No network in this test, but something fetched ${String(input)}`);
        }) as typeof globalThis.fetch,
      });
      if (code !== 0) throw new Error(`skeinwise ${argv.join(' ')} exited ${code}: ${err}`);
    };
  }

  /** Each live Projects tag, by name, with the external ids of its entries: two records compare by what they hold. */
  function projectTags(db: Store['db']): Record<string, string[]> {
    const store = new Store(db, () => DEMO_NOW);
    const ext = new Map(store.allEntries().map((e) => [e.id, e.externalId]));
    const live = liveTags(db, findSchema(db, 'Projects')!.id);
    return Object.fromEntries(live.map((t) => [t.name, t.entryIds.map((id) => ext.get(id)!).sort()]));
  }

  it(`ends with at most ${PROJECT_MAX} Projects tags and no daily note among them; tags a person or an agent added stay`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'skeinwise-projects-rerun-'));
    roots.push(root);
    // The demo record, and a vault that links more plans than the cap and two daily notes, each from two entries.
    const vault = join(root, 'vault');
    writeNotes(vault, {
      ...plans(),
      'daily/Allotment week.md': { title: 'Allotment week', body: 'Logged the week, about bread and the starter.' },
      '2019-03-04.md': { title: '2019-03-04', body: 'Rain all day.' },
      'Allotment Monday.md': { title: 'Allotment Monday', body: 'See [[Allotment week]] and [[2019-03-04]]. Fed the sourdough starter.' },
      'Allotment Tuesday.md': { title: 'Allotment Tuesday', body: 'Again [[Allotment week]] and [[2019-03-04]]. Baked rye bread.' },
    });
    const sw = inHome(join(root, 'home'));
    await sw('demo');
    await sw('import', vault);
    await sw('define-tag', 'Kitchen', 'bread', 'sourdough', 'rye', 'loaf', 'starter');

    // What the old rule left: a project for every note linked from two or more other entries, daily notes too, on the
    // note and on each entry that links to it.
    const before = openDb(join(root, 'home', 'record.db'));
    const old = new Store(before, () => DEMO_NOW);
    const record = new RecordView(old);
    const linkers = new Map<Entry, Set<number>>();
    for (const e of record.entries) {
      for (const target of linkTargets(e.body)) {
        const note = record.resolveLink(target);
        if (!note || note.id === e.id) continue;
        if (!linkers.has(note)) linkers.set(note, new Set());
        linkers.get(note)!.add(e.id);
      }
    }
    const projects = findSchema(before, 'Projects')!;
    const oldRun = startRun(before, { task: 'tag', engine: 'none', model: null, scope: 'all', schemaId: projects.id, mark: currentMark(before), now: DEMO_NOW });
    for (const [note, from] of linkers) {
      if (from.size < 2) continue;
      const tag = before.prepare('INSERT INTO tags (schema_id, name, description, run_id) VALUES (?, ?, ?, ?)').run(projects.id, note.title!, '', oldRun);
      for (const id of [note.id, ...from]) {
        before.prepare('INSERT INTO entry_tags (entry_id, tag_id, run_id, score) VALUES (?, ?, ?, 1)').run(id, Number(tag.lastInsertRowid), oldRun);
      }
    }
    finishRun(before, oldRun, { counts: {}, tokensIn: 0, tokensOut: 0, now: DEMO_NOW });
    const daily = record.entries.filter(isDailyNote).map((e) => e.title!);
    expect(daily).toEqual(expect.arrayContaining(['Allotment week', '2019-03-04']));
    const oldNames = Object.keys(projectTags(before));
    expect(oldNames.length).toBeGreaterThan(PROJECT_MAX + 5);
    expect(oldNames).toEqual(expect.arrayContaining(['Allotment week', '2019-03-04']));
    const monday = old.allEntries().find((e) => e.title === 'Allotment Monday')!;
    tagAsAgent(old, 'helper', { entryIds: [monday.id], tag: 'baking' }, DEMO_NOW);
    before.close();

    await sw('run', 'all', '--engine', 'none');

    const after = openDb(join(root, 'home', 'record.db'));
    const now = projectTags(after);
    expect(Object.keys(now).length).toBeLessThanOrEqual(PROJECT_MAX);
    expect(Object.keys(now).filter((name) => daily.includes(name))).toEqual([]);
    expect(after.prepare('SELECT 1 FROM live_runs WHERE id = ?').get(oldRun)).toBeUndefined();
    // Your own tag and an agent's tag are not the organiser's to replace.
    const kitchen = findSchema(after, 'Kitchen')!;
    expect(definedTags(after, kitchen.id).map((t) => t.name)).toEqual(['bread']);
    expect(liveTags(after, kitchen.id).find((t) => t.name === 'bread')?.entryIds).toContain(monday.id);
    expect(liveTags(after, findSchema(after, 'Agent tags')!.id)).toEqual([expect.objectContaining({ name: 'baking', entryIds: [monday.id] })]);
    after.close();

    // Nothing of the old run is left: the record holds the same projects as one that never ran the old rule.
    const fresh = inHome(join(root, 'fresh'));
    await fresh('demo');
    await fresh('import', vault);
    await fresh('run', 'tag', '--schema', 'Projects', '--engine', 'none');
    const clean = openDb(join(root, 'fresh', 'record.db'));
    expect(now).toEqual(projectTags(clean));
    expect(Object.keys(now)).toHaveLength(PROJECT_MAX);
    clean.close();
  });
});
