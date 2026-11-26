import { describe, expect, it } from 'vitest';
import { type EntryRow, tableCounts } from '../../src/server/buckets.ts';
import { BUILTINS, builtin, closestBuiltin } from '../../src/viewspec/builtins.ts';
import { ALL_ENTRIES, keptRows, resolveSpec, viewCell, viewData } from '../../src/viewspec/data.ts';
import { checkSpec, type ChartSpec, type ListSpec } from '../../src/viewspec/spec.ts';

let next = 1;
function row(over: Partial<EntryRow>): EntryRow {
  const id = next++;
  return {
    id,
    kind: 'message',
    speaker: 'you',
    sourceId: 1,
    source: 'Chats',
    sourceKind: 'chat',
    threadId: 10,
    folder: 'Inbox',
    project: null,
    hub: null,
    tag: null,
    createdAt: '2025-03-14T09:00:00.000Z',
    title: `Entry ${id}`,
    ...over,
  };
}

const rows: EntryRow[] = [
  row({ createdAt: '2025-01-05T08:00:00.000Z', project: 'Garden', speaker: 'you' }),
  row({ createdAt: '2025-01-20T08:00:00.000Z', project: 'Garden', speaker: 'assistant' }),
  row({ createdAt: '2025-03-01T00:00:00.000Z', project: 'Sourdough', speaker: 'you', tag: 'Baking' }),
  row({ createdAt: '2025-03-31T23:59:59.000Z', kind: 'note', speaker: 'you', source: 'Notes', threadId: null, title: 'Rye ratios' }),
  row({ createdAt: '2025-04-02T10:00:00.000Z', kind: 'note', speaker: 'you', source: 'Notes', threadId: null, project: 'Garden', title: 'Tomato beds' }),
];

const chart = (over: Partial<ChartSpec> = {}): ChartSpec => ({ v: 1, title: 'T', show: 'chart', form: 'bars', x: 'time', ...over });
const list = (over: Partial<ListSpec> = {}): ListSpec => ({ v: 1, title: 'L', show: 'list', sort: 'newest', limit: 50, ...over });

describe('the built-in views', () => {
  it('each passes the validator unchanged and has its own id', () => {
    for (const b of BUILTINS) {
      expect(checkSpec(b.spec), b.id).toEqual({ ok: true, spec: b.spec });
      expect(b.id).toMatch(/^[a-z0-9-]{1,40}$/);
    }
    expect(new Set(BUILTINS.map((b) => b.id)).size).toBe(BUILTINS.length);
    expect(builtin('notes')?.spec.show).toBe('list');
    expect(builtin('nope')).toBeUndefined();
  });

  it('picks the closest by the fields that passed, then by the words asked', () => {
    expect(closestBuiltin({}).id).toBe('by-month');
    expect(closestBuiltin({}, 'my notes').id).toBe('notes');
    expect(closestBuiltin({ show: 'chart', y: 'project' }).id).toBe('projects-over-time');
    expect(closestBuiltin({ show: 'list' }, 'what did I add recently').id).toBe('newest');
    expect(closestBuiltin({}, 'which topics come up most').id).toBe('tags-by-month');
    expect(closestBuiltin({}, 'who talked more, me or the assistant?').id).toBe('speakers-by-month');
    expect(closestBuiltin({ show: 'chart', x: 'folder' }).id).toBe('folders-by-source');
    expect(closestBuiltin({ show: 'list', where: [{ prop: 'kind', is: 'note' }] }).id).toBe('notes');
    expect(closestBuiltin({ title: 'Sources over the year' }).id).toBe('sources-by-month');
  });
});

describe('resolveSpec', () => {
  it("matches filter values to the record's own spelling, ignoring case", () => {
    const r = resolveSpec(list({ where: [{ prop: 'project', is: 'garden' }, { prop: 'kind', is: 'note' }] }), rows);
    expect(r).toEqual({ ok: true, spec: list({ where: [{ prop: 'project', is: 'Garden' }, { prop: 'kind', is: 'note' }] }) });
    expect(resolveSpec(list({ where: [{ prop: 'project', is: 'no project yet' }] }), rows)).toMatchObject({ ok: true, spec: { where: [{ is: 'No project yet' }] } });
  });

  it('says which value the record does not have; months and kinds pass as they are', () => {
    expect(resolveSpec(chart({ where: [{ prop: 'tag', is: 'Pottery' }, { prop: 'source', is: 'Mail' }] }), rows)).toEqual({
      ok: false,
      reasons: ['Your record has no tag called "Pottery".', 'Your record has no source called "Mail".'],
    });
    expect(resolveSpec(chart({ where: [{ prop: 'time', is: '1999-01' }] }), rows).ok).toBe(true);
    expect(resolveSpec(chart(), rows)).toEqual({ ok: true, spec: chart() });
  });
});

describe('keptRows', () => {
  it('keeps rows that meet every filter, with dates as inclusive months or days', () => {
    expect(keptRows(rows, list({ where: [{ prop: 'project', is: 'Garden' }] })).map((r) => r.id)).toEqual([rows[0]!.id, rows[1]!.id, rows[4]!.id]);
    expect(keptRows(rows, list({ where: [{ prop: 'project', is: 'Garden' }, { prop: 'kind', is: 'note' }] })).map((r) => r.title)).toEqual(['Tomato beds']);
    expect(keptRows(rows, list({ from: '2025-03', to: '2025-03' })).map((r) => r.id)).toEqual([rows[2]!.id, rows[3]!.id]);
    expect(keptRows(rows, list({ from: '2025-01-20', to: '2025-03-01' })).map((r) => r.id)).toEqual([rows[1]!.id, rows[2]!.id]);
    expect(keptRows(rows, list({ where: [{ prop: 'time', is: '2025-04' }] }))).toHaveLength(1);
  });
});

describe('viewData', () => {
  it('lists entries newest or oldest first, cut to the limit, with the full count', () => {
    const newest = viewData(rows, list({ limit: 2 }));
    expect(newest).toMatchObject({ show: 'list', total: 5 });
    expect(newest.show === 'list' && newest.items.map((i) => i.title)).toEqual(['Tomato beds', 'Rye ratios']);
    const oldest = viewData(rows, list({ sort: 'oldest', limit: 1 }));
    expect(oldest.show === 'list' && oldest.items).toEqual([
      { id: rows[0]!.id, kind: 'message', title: rows[0]!.title, createdAt: rows[0]!.createdAt, speaker: 'you', source: 'Chats', threadId: 10 },
    ]);
  });

  it("counts a chart with the Workbench's own table", () => {
    const d = viewData(rows, chart({ y: 'speaker', where: [{ prop: 'source', is: 'Chats' }] }));
    expect(d).toEqual({ show: 'chart', table: tableCounts(rows.slice(0, 3), 'time', 'speaker'), single: false, total: 3 });
  });

  it('adds a chart with no y up into one row', () => {
    const d = viewData(rows, chart({ x: 'project' }));
    expect(d.show === 'chart' && d.table).toMatchObject({ xs: ['Garden', 'No project yet', 'Sourdough'], ys: [ALL_ENTRIES], cells: [[3, 1, 1]], max: 3, total: 5 });
    expect(d.show === 'chart' && d.single).toBe(true);
    const months = viewData(rows, chart());
    expect(months.show === 'chart' && months.table.cells).toEqual([[2, 0, 2, 1]]);
    const none = viewData(rows, chart({ from: '2030-01' }));
    expect(none.show === 'chart' && none.table).toMatchObject({ xs: [], ys: [], cells: [], max: 0, total: 0 });
  });

  it('gives the entries behind one cell, with or without a y', () => {
    expect(viewCell(rows, chart({ y: 'speaker' }), '2025-01', 'assistant')).toMatchObject({ total: 1, entries: [{ id: rows[1]!.id }] });
    expect(viewCell(rows, chart({ x: 'project' }), 'Garden', null).entries.map((e) => e.id)).toEqual([rows[4]!.id, rows[1]!.id, rows[0]!.id]);
    expect(viewCell(rows, list(), 'Garden', null)).toEqual({ total: 0, entries: [] });
  });
});
