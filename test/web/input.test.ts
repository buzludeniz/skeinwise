import { describe, expect, it } from 'vitest';
import type { BrainData, BrainPoint } from '../../src/server/queries.ts';
import { buildModel, legendColors, litValues } from '../../web/src/brain/input.ts';
import { palette, theme } from '../../web/src/themes.ts';

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
    projects: [],
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
    [4, 1, 0, 9, 0, 0, -1, t('2025-04-01T00:00:00Z'), 'Garden plan'],
    [5, 1, 0, 9, 0, 0, -1, t('2025-05-01T00:00:00Z'), 'Seeds'],
    [6, 1, 0, 9, 0, 0, -1, t('2025-06-01T00:00:00Z'), '  '],
  ],
  [[4, 5, 0]],
);

const dusk = theme('dusk');
const ember = palette('ember');

describe('brain input', () => {
  it('gives each point its group colour and a size by kind', () => {
    const m = buildModel(sample, 'source', ember, dusk);
    expect(m.legend.map((g) => [g.label, g.count])).toEqual([
      ['Claude', 3],
      ['notes', 3],
    ]);
    expect(m.input.colors).toHaveLength(18);
    // Points 0 and 3 sit in different groups, so their colours differ.
    expect([...m.input.colors.slice(0, 3)]).not.toEqual([...m.input.colors.slice(9, 12)]);
    // Notes are larger than messages, and a linked note larger than an unlinked one.
    expect(m.input.sizes[3]!).toBeGreaterThan(m.input.sizes[0]!);
    expect(m.input.sizes[3]!).toBeGreaterThan(m.input.sizes[5]!);
    expect(m.indexOf.get(4)).toBe(3);
  });

  it('labels the most-linked notes first and skips blank titles', () => {
    const m = buildModel(sample, 'source', ember, dusk);
    expect(m.input.labels.map((l) => l.text)).toEqual(['Seeds', 'Garden plan']);
  });

  it('gives the long tail of groups one shared quiet colour', () => {
    const colors = legendColors(14, ember, dusk);
    expect(colors.slice(0, 9)).toEqual(ember.colors.slice(0, 9));
    expect(new Set(colors.slice(9)).size).toBe(1);
    expect(legendColors(ember.colors.length, ember, dusk)).toEqual(ember.colors);
  });

  it('lights matches, dims the rest and isolates a group', () => {
    const m = buildModel(sample, 'source', ember, dusk);
    expect(litValues(m, null, null)).toBeNull();
    expect([...litValues(m, new Set([2, 5]), null)!]).toEqual([0, 2, 0, 0, 2, 0]);
    expect([...litValues(m, null, 1)!]).toEqual([0, 0, 0, 1, 1, 1]);
    expect([...litValues(m, new Set([2, 5]), 1)!]).toEqual([0, 0, 0, 0, 2, 0]);
  });

  it('adds one large labelled point per hub, with a spoke to each entry it holds', () => {
    const withHubs: BrainData = {
      ...sample,
      hubs: [
        { id: 11, name: 'Sowing depth', entries: [1, 2, 99] },
        { id: 12, name: 'Gone', entries: [98] },
      ],
    };
    const m = buildModel(withHubs, 'source', ember, dusk);
    // The hub with no entries left is skipped; the other comes after every entry.
    expect(m.hubs).toEqual([{ index: 6, id: 11, name: 'Sowing depth', count: 2 }]);
    expect(m.input.points[6]).toMatchObject({ id: -11, kind: 1, time: t('2025-03-02T10:01:00Z'), group: 0 });
    expect([...m.input.spokes]).toEqual([6, 0, 6, 1]);
    expect(m.input.sizes[6]!).toBeGreaterThan(Math.max(...m.input.sizes.slice(0, 6)));
    expect(m.input.labels.map((l) => l.text)).toEqual(['Sowing depth', 'Seeds', 'Garden plan']);
    // The legend counts entries only.
    expect(m.legend.map((g) => g.count)).toEqual([3, 3]);
    // A hub lights with any of its entries, and isolates with its group.
    expect([...litValues(m, new Set([2]), null)!]).toEqual([0, 2, 0, 0, 0, 0, 2]);
    expect([...litValues(m, null, 1)!]).toEqual([0, 0, 0, 1, 1, 1, 0]);
  });
});
