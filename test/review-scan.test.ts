// Review weighs each note against your later entries in its hubs or naming it. It used to scan all your entries for
// every note (5,000 notes × 28,000 entries, 33 s of a run all at 50k); now a note visits only its own hubs' members and
// its title stems' holders from its date on. These tests hold the new way to the old scan, kept below as it was at
// 11da41a: the same notes, the same newer entries in the same order, and so the same flags and model requests, on a
// record with one big hub, over everything and over a few new entries.

import type { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TaskContext } from '../src/organiser/plan.ts';
import { isDailyNote, RecordView, vouched } from '../src/organiser/record.ts';
import { type Check, planReview, reviewChecks } from '../src/organiser/review.ts';
import { tokenize } from '../src/organiser/text.ts';
import { heldEntries, hubEntryIds, liveHubs } from '../src/organiser/views.ts';
import { openDb } from '../src/store/db.ts';
import { type Entry, type EntryInput, Store, type ThreadInput } from '../src/store/store.ts';

const NOW = '2026-06-01T00:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;

/** reviewChecks as it was at 11da41a: every note against all your entries. */
function scanChecks(ctx: TaskContext): Check[] {
  const { record, db } = ctx;
  const hubs = liveHubs(db);
  const hubsOf = new Map<number, number[]>();
  for (const h of hubs) for (const id of hubEntryIds(db, h.id)) hubsOf.set(id, [...(hubsOf.get(id) ?? []), h.id]);
  const scoped = new Set(ctx.entries.map((e) => e.id));
  const touched = new Set(ctx.entries.flatMap((e) => hubsOf.get(e.id) ?? []));
  const notes = record.entries.filter(
    (e) =>
      e.kind === 'note' &&
      e.speaker === 'you' &&
      !isDailyNote(e) &&
      hubsOf.has(e.id) &&
      (ctx.scope.kind === 'all' || scoped.has(e.id) || hubsOf.get(e.id)!.some((h) => touched.has(h))),
  );
  const yours = record.entries.flatMap((e) => (e.speaker === 'you' && vouched(e, ctx.now) ? [{ e, at: Date.parse(e.createdAt) }] : []));
  const names = new Map(notes.map((n) => [n.id, [...new Set(tokenize(n.title ?? ''))]]));
  const stems = new Set([...names.values()].flat());
  const holding = new Map<string, Set<number>>();
  for (const { e } of yours) for (const s of tokenize(e.body)) if (stems.has(s)) holding.set(s, (holding.get(s) ?? new Set()).add(e.id));
  return notes.map((note) => {
    const since = note.version <= 1 ? note.createdAt : record.store.history(note.id).at(-1)!.editedAt;
    const held = heldEntries(db, note.id);
    const own = new Set(hubsOf.get(note.id));
    const name = names.get(note.id)!;
    const after = Date.parse(since) + DAY;
    const newer = yours.flatMap(({ e, at }) =>
      e.id !== note.id &&
      at >= after &&
      !held.has(e.id) &&
      ((hubsOf.get(e.id) ?? []).some((h) => own.has(h)) || (name.length > 0 && name.every((s) => holding.get(s)?.has(e.id))))
        ? [e]
        : [],
    );
    return { note, since, newer, hubs: [...own] };
  });
}

const ids = (checks: Check[]) => checks.map((c) => ({ note: c.note.id, since: c.since, newer: c.newer.map((e) => e.id), hubs: c.hubs }));

/** What review would queue from these checks with the No-AI engine, and the requests it would send a model. */
function verdicts(ctx: TaskContext, checks?: Check[]) {
  const product = planReview(ctx, checks).finish([]);
  const rows: unknown[][] = [];
  product.save({ prepare: () => ({ run: (...args: unknown[]) => rows.push(args) }) } as unknown as DatabaseSync, 1);
  const asks = planReview({ ...ctx, model: true, engine: 'local', modelName: 'stand-in' }, checks).requests.map((r) => r.user);
  return { counts: product.counts, message: product.message, rows, asks };
}

/** A seeded random number generator (mulberry32), so the record is the same on every run. */
function random(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('review visits only each note’s candidates, and finds what the full scan found', () => {
  let store: Store;
  let record: RecordView;
  /** Each live hub's members. */
  let members: Map<number, Set<number>>;
  /** In scope for the scoped run: a message only in the big hub, a note in a small hub, an entry in no hub. */
  let fresh: number[];
  const ctx = (scope: 'all' | 'new'): TaskContext => ({
    db: store.db,
    record,
    scope: { kind: scope },
    entries: scope === 'all' ? record.entries : record.entries.filter((e) => fresh.includes(e.id)),
    model: false,
    engine: 'none',
    modelName: null,
    now: NOW,
  });

  beforeAll(() => {
    const r = random(42);
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
    const WORDS = ['garden', 'rye', 'pension', 'river', 'oven', 'flour', 'sqlite', 'market', 'kubernetes', 'plan', 'index', 'starter'];
    const CUES = ['No longer', 'Changing my mind on', 'Decided:', 'We switch to', 'Instead of'];
    const sentence = () => {
      const words = Array.from({ length: 3 + Math.floor(r() * 5) }, () => pick(WORDS)).join(' ');
      return r() < 0.3 ? `${pick(CUES)} the ${words} now.` : `The ${words} today.`;
    };
    const body = () => Array.from({ length: 1 + Math.floor(r() * 3) }, sentence).join(' ');
    const START = Date.parse('2023-06-01T00:00:00.000Z');
    const END = Date.parse('2026-05-01T00:00:00.000Z');
    // On the hour, so entries share times.
    const when = () => new Date(START + Math.floor((r() * (END - START)) / 3_600_000) * 3_600_000).toISOString();

    let clock = NOW;
    store = new Store(openDb(':memory:'), () => clock);
    const notes: EntryInput[] = Array.from({ length: 100 }, (_, i) => {
      // An untitled note and one titled with a stop word only have no stems to be named by.
      const title = i === 0 ? '' : i === 1 ? 'The' : i % 3 === 0 ? pick(WORDS) : `${pick(WORDS)} ${pick(WORDS)}`;
      return { externalId: `n${i}.md`, kind: 'note', speaker: 'you', title, createdAt: when(), body: `${title}. ${body()}` };
    });
    notes.push({ externalId: 'daily/2025-03-04.md', kind: 'note', speaker: 'you', title: '2025-03-04', createdAt: '2025-03-04T09:00:00.000Z', body: body() });
    const threads: ThreadInput[] = Array.from({ length: 250 }, (_, t) => ({
      externalId: `t${t}`,
      title: `Thread ${t}`,
      entries: Array.from({ length: 6 }, (_, m) => ({ externalId: `t${t}-m${m}`, kind: 'message' as const, speaker: m % 3 === 2 ? 'assistant' : 'you', createdAt: when(), body: body() })),
    }));
    // Entries naming notes 2 to 9 a day after them to the millisecond (in), and a millisecond short of that (out).
    threads.push({
      externalId: 'edges',
      title: 'Edges',
      entries: notes.slice(2, 10).flatMap((n, i) => [
        { externalId: `edge-${i}-in`, kind: 'message' as const, speaker: 'you', createdAt: new Date(Date.parse(n.createdAt) + DAY).toISOString(), body: `No longer ${n.title} as it was.` },
        { externalId: `edge-${i}-out`, kind: 'message' as const, speaker: 'you', createdAt: new Date(Date.parse(n.createdAt) + DAY - 1).toISOString(), body: `Decided: ${n.title} anew.` },
      ]),
    });
    // Dated ahead of the run or before 1990: never weighed.
    threads.push({
      externalId: 'odd-dates',
      title: 'Odd dates',
      entries: [
        { externalId: 'ahead', kind: 'message', speaker: 'you', createdAt: '2026-09-01T00:00:00.000Z', body: `No longer the ${WORDS.join(' ')}.` },
        { externalId: 'old', kind: 'message', speaker: 'you', createdAt: '1985-01-01T00:00:00.000Z', body: `No longer the ${WORDS.join(' ')}.` },
      ],
    });
    store.ingest({ source: { kind: 'notes', label: 'notes', location: '/n' }, threads: [], entries: notes });
    store.ingest({ source: { kind: 'chatgpt', label: 'ChatGPT', location: '' }, threads });

    const all = store.allEntries();
    const byExternal = new Map(all.map((e) => [e.externalId, e]));
    // Some notes changed later than they were written, so `since` comes from their history.
    for (const i of [3, 11, 17, 29, 42, 55, 68, 81]) {
      clock = when();
      store.editEntry(byExternal.get(`n${i}.md`)!.id, `${notes[i]!.body} Edited.`);
    }
    clock = NOW;

    const db = store.db;
    const run = (task: string, scope: string, status = 'done') =>
      Number(db.prepare("INSERT INTO runs (task, engine, scope, status, started_at) VALUES (?, 'none', ?, ?, ?)").run(task, scope, status, NOW).lastInsertRowid);
    const hub = (name: string, runId: number, replaces: number | null = null) =>
      Number(db.prepare("INSERT INTO hubs (name, sections, run_id, replaces) VALUES (?, '{}', ?, ?)").run(name, runId, replaces).lastInsertRowid);
    const member = (hubId: number, entryId: number, runId: number) =>
      db.prepare('INSERT INTO hub_entries (hub_id, entry_id, run_id, score) VALUES (?, ?, ?, 1)').run(hubId, entryId, runId);
    const first = run('hub', 'all');
    const later = run('hub', 'new');
    const undone = run('hub', 'all', 'undone');
    // One hub holds about 60% of the record, as hub 1 holds 15,000 of the 50k bench's entries.
    const big = hub('Big', first);
    const bigMembers = all.filter(() => r() < 0.6);
    for (const e of bigMembers) member(big, e.id, first);
    // A later run over new entries lists some of them again, so the big hub names them twice.
    for (const e of bigMembers.slice(0, 50)) member(big, e.id, later);
    const small = Array.from({ length: 6 }, (_, i) => hub(`Small ${i}`, first));
    for (const h of small) for (const e of all) if (r() < 0.07) member(h, e.id, first);
    // A hub replaced by a later copy, and a hub of an undone run: neither is live.
    const copy = hub('Small 0, again', later, small[0]!);
    for (const e of all) if (r() < 0.05) member(copy, e.id, later);
    const gone = hub('Undone', undone);
    for (const e of all) if (e.kind === 'note') member(gone, e.id, undone);

    // Entries a note was said to hold against are not weighed again; only done runs' "holds" count.
    const review = run('review', 'all');
    const failed = run('review', 'all', 'failed');
    const item = db.prepare('INSERT INTO review_items (note_entry, reasons, status, proposed, run_id) VALUES (?, ?, ?, ?, ?)');
    const reasons = () => JSON.stringify(Array.from({ length: 5 }, () => ({ entryId: pick(bigMembers).id, date: '2025-01-01', quote: 'q', why: 'w' })));
    const noteIds = all.filter((e) => e.kind === 'note').map((e) => e.id);
    for (const id of noteIds.slice(0, 30)) item.run(id, reasons(), 'holds', '', review);
    for (const id of noteIds.slice(30, 40)) item.run(id, reasons(), 'open', '', review);
    for (const id of noteIds.slice(40, 50)) item.run(id, reasons(), 'holds', '', failed);

    record = new RecordView(store);
    members = new Map(liveHubs(db).map((h) => [h.id, new Set(hubEntryIds(db, h.id))]));
    const hubsOf = (id: number) => [...members].filter(([, m]) => m.has(id)).map(([h]) => h);
    const onlyBig = record.entries.find((e) => e.kind === 'message' && hubsOf(e.id).join() === String(big))!;
    const smallNote = record.entries.find((e) => e.kind === 'note' && e.title && hubsOf(e.id).length > 0 && !hubsOf(e.id).includes(big))!;
    const loose = record.entries.find((e) => e.kind === 'message' && hubsOf(e.id).length === 0)!;
    fresh = [onlyBig.id, smallNote.id, loose.id];
  });

  it('gives every note the same newer entries, in the same order, over everything', () => {
    const want = scanChecks(ctx('all'));
    const got = reviewChecks(ctx('all'));
    expect(ids(got)).toEqual(ids(want));
    // The record exercises what the index has to get right.
    expect(Math.max(...got.map((c) => c.newer.length))).toBeGreaterThan(300);
    // Some are there only because they name the note.
    expect(got.some((c) => c.newer.some((e) => !c.hubs.some((h) => members.get(h)!.has(e.id))))).toBe(true);
    const atEdge = got.some((c) => c.newer.some((e) => Date.parse(e.createdAt) === Date.parse(c.since) + DAY));
    expect(atEdge).toBe(true);
  });

  it('gives every note the same newer entries over a few new ones', () => {
    const want = scanChecks(ctx('new'));
    expect(want.length).toBeGreaterThan(0);
    expect(want.length).toBeLessThan(scanChecks(ctx('all')).length);
    expect(ids(reviewChecks(ctx('new')))).toEqual(ids(want));
  });

  it('flags the same notes for the same reasons, and asks a model the same, both ways', () => {
    for (const scope of ['all', 'new'] as const) {
      const want = verdicts(ctx(scope), scanChecks(ctx(scope)));
      const got = verdicts(ctx(scope));
      expect(got).toEqual(want);
      expect(got.rows.length).toBeGreaterThan(0);
      expect(got.asks.length).toBeGreaterThan(0);
    }
  });
});
