import { describe, expect, it } from 'vitest';
import {
  cellEntries,
  type EntryRow,
  monthsBetween,
  OTHER,
  parseFilter,
  tableCounts,
  tides,
  timelineBuckets,
  UNSET,
  weeksBetween,
  weekStart,
} from '../../src/server/buckets.ts';

let next = 1;
function row(createdAt: string, source = 'ChatGPT', speaker = 'you', extra: Partial<EntryRow> = {}): EntryRow {
  return {
    id: next++,
    kind: 'message',
    speaker,
    sourceId: 1,
    source,
    sourceKind: source.toLowerCase(),
    threadId: 1,
    folder: 'Inbox',
    project: null,
    hub: null,
    tag: null,
    createdAt,
    title: 'x',
    ...extra,
  };
}

describe('week and month maths', () => {
  it('starts weeks on Monday, in UTC', () => {
    expect(weekStart('2026-11-25T10:00:00Z')).toBe('2026-11-23'); // a Wednesday
    expect(weekStart('2026-11-23T00:00:00Z')).toBe('2026-11-23'); // the Monday itself
    expect(weekStart('2026-11-29T23:59:59Z')).toBe('2026-11-23'); // the Sunday
    expect(weekStart('2027-01-01T12:00:00Z')).toBe('2026-12-28'); // across a year end
    expect(() => weekStart('not a date')).toThrow('Not a date');
  });

  it('lists every week and month in a span, with no gaps', () => {
    expect(weeksBetween('2026-11-25', '2026-12-08')).toEqual(['2026-11-23', '2026-11-30', '2026-12-07']);
    expect(monthsBetween('2025-11-03', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsBetween('2026-02-10', '2026-02-11')).toEqual(['2026-02']);
  });
});

describe('the timeline', () => {
  it('counts entries per week per source, biggest series first', () => {
    const rows = [
      row('2026-11-02T10:00:00Z', 'Claude'),
      row('2026-11-03T10:00:00Z', 'ChatGPT'),
      row('2026-11-04T10:00:00Z', 'ChatGPT'),
      row('2026-11-18T10:00:00Z', 'ChatGPT', 'assistant'),
    ];
    const t = timelineBuckets(rows, 'source');
    expect(t.weeks).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
    expect(t.series.map((s) => [s.key, s.counts, s.total])).toEqual([
      ['ChatGPT', [2, 0, 1], 3],
      ['Claude', [1, 0, 0], 1],
    ]);
    expect(timelineBuckets(rows, 'speaker').series.map((s) => s.key)).toEqual(['you', 'assistant']);
  });

  it('is empty for an empty record', () => {
    expect(timelineBuckets([], 'source')).toEqual({ weeks: [], series: [] });
  });
});

describe('the table builder', () => {
  const rows = [
    row('2026-01-05T00:00:00Z', 'ChatGPT'),
    row('2026-01-06T00:00:00Z', 'Claude'),
    row('2026-03-01T00:00:00Z', 'Claude', 'you', { project: 'Thesis' }),
  ];

  it('counts cells over contiguous months', () => {
    const t = tableCounts(rows, 'time', 'source');
    expect(t.xs).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(t.ys).toEqual(['Claude', 'ChatGPT']);
    expect(t.cells).toEqual([
      [1, 0, 1],
      [1, 0, 0],
    ]);
    expect(t.total).toBe(3);
    expect(t.max).toBe(1);
  });

  it('names unset values and filters by one property', () => {
    const t = tableCounts(rows, 'project', 'source');
    expect(t.xs).toContain(UNSET.project);
    expect(t.xs).toContain('Thesis');
    const only = tableCounts(rows, 'time', 'source', parseFilter('source:Claude'));
    expect(only.total).toBe(2);
    expect(parseFilter('nonsense')).toBeNull();
    expect(parseFilter('')).toBeNull();
  });

  it('folds long tails into Other', () => {
    const many = Array.from({ length: 30 }, (_, i) => row('2026-01-01T00:00:00Z', `Source ${i}`));
    const t = tableCounts(many, 'source', 'speaker');
    expect(t.xs).toHaveLength(24);
    expect(t.xs.at(-1)).toBe(OTHER);
    expect(t.total).toBe(30);
  });

  it('lists the entries behind one cell', () => {
    expect(cellEntries(rows, 'time', '2026-01', 'source', 'Claude', null).map((r) => r.createdAt)).toEqual(['2026-01-06T00:00:00Z']);
  });

  it('draws tides as one line per source per month', () => {
    const t = tides(rows, 'source');
    expect(t.months).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(t.lines.find((l) => l.key === 'Claude')?.counts).toEqual([1, 0, 1]);
  });
});
