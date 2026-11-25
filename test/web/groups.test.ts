import { describe, expect, it } from 'vitest';
import type { BrainData, BrainPoint } from '../../src/server/queries.ts';
import { ago, fmtBytes, fmtDate, fmtMonth, fmtNum, fmtRange, plural } from '../../web/src/format.ts';
import { groupPoints, layoutPoints, linkDegree, linkPairs, threadPairs } from '../../web/src/groups.ts';

const t = (iso: string) => Date.parse(iso);

function data(points: BrainPoint[], links: [number, number, number][] = []): BrainData {
  return {
    kinds: ['message', 'note', 'file'],
    speakers: ['you', 'assistant'],
    sources: [
      { id: 7, label: 'Claude', kind: 'claude' },
      { id: 9, label: 'notes', kind: 'notes' },
    ],
    folders: ['notes', 'Inbox'],
    projects: ['Garden'],
    threads: { '3': 'Beans' },
    points,
    links,
    hubs: [],
    organiser: false,
  };
}

const sample = data(
  [
    [1, 0, 0, 7, 3, 1, -1, t('2025-03-02T10:00:00Z'), 'How deep?'],
    [2, 0, 1, 7, 3, 1, -1, t('2025-03-02T10:01:00Z'), 'About 3 cm'],
    [3, 0, 0, 7, 3, 1, -1, t('2025-03-01T09:00:00Z'), 'Beans'],
    [4, 1, 0, 9, 0, 0, 0, t('2025-04-01T00:00:00Z'), 'Garden plan'],
    [5, 1, 0, 9, 0, 0, -1, t('2025-05-01T00:00:00Z'), 'Seeds'],
  ],
  [
    [4, 5, 0],
    [5, 99, 0],
  ],
);

describe('groups', () => {
  it('groups by source, biggest first, with an index per point', () => {
    const g = groupPoints(sample, 'source');
    expect(g.groups).toEqual([
      { label: 'Claude', count: 3 },
      { label: 'notes', count: 2 },
    ]);
    expect([...g.of]).toEqual([0, 0, 0, 1, 1]);
  });

  it('names speakers and projects as people read them', () => {
    expect(groupPoints(sample, 'speaker').groups.map((x) => x.label)).toEqual(['You', 'Assistant']);
    expect(groupPoints(sample, 'project').groups).toEqual([
      { label: 'No project', count: 4 },
      { label: 'Garden', count: 1 },
    ]);
  });

  it('keeps months in calendar order', () => {
    expect(groupPoints(sample, 'month').groups.map((x) => x.label)).toEqual(['March', 'April', 'May']);
  });

  it('clusters notes by project, else folder, and winds originals by source', () => {
    const lp = layoutPoints(sample, groupPoints(sample, 'source').of);
    expect(lp[3]!.cluster).toBe(1000);
    expect(lp[4]!.cluster).toBe(0);
    expect(lp.map((p) => p.strand)).toEqual([0, 0, 0, 1, 1]);
  });

  it('joins thread entries in time order and skips links to missing points', () => {
    expect([...threadPairs(sample)]).toEqual([2, 0, 0, 1]);
    expect([...linkPairs(sample)]).toEqual([3, 4]);
    expect([...linkDegree(sample)]).toEqual([0, 0, 0, 1, 2]);
  });
});

describe('format', () => {
  it('writes dates, months and ranges in UTC', () => {
    expect(fmtDate('2026-11-03T23:30:00Z')).toBe('3 Nov 2026');
    expect(fmtMonth('2024-01')).toBe('Jan 2024');
    expect(fmtRange('2024-01-18T00:00:00Z', '2026-09-11T20:56:58Z')).toBe('Jan 2024 – Sep 2026');
    expect(fmtRange('2024-01-18T01:00:00Z', '2024-01-18T05:00:00Z')).toBe('18 Jan 2024');
    expect(fmtRange(null, null)).toBe('');
  });

  it('writes numbers, plurals and sizes', () => {
    expect(fmtNum(1234567)).toBe('1,234,567');
    expect(plural(1, 'entry', 'entries')).toBe('1 entry');
    expect(plural(1200, 'entry', 'entries')).toBe('1,200 entries');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 KB');
    expect(fmtBytes(30 * 1024 * 1024)).toBe('30 MB');
  });

  it('says how long ago', () => {
    const now = t('2026-11-25T12:00:00Z');
    expect(ago('2026-11-25T11:59:40Z', now)).toBe('just now');
    expect(ago('2026-11-25T11:58:00Z', now)).toBe('2 minutes ago');
    expect(ago('2026-11-25T09:00:00Z', now)).toBe('3 hours ago');
    expect(ago('2026-11-24T10:00:00Z', now)).toBe('yesterday');
    expect(ago('2026-11-01T10:00:00Z', now)).toBe('1 Nov 2026');
  });
});
