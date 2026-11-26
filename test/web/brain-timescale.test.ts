// The cord's calendar (web/src/brain/timescale.ts): months stacked oldest first with this month on top, heights that
// grow with the log of a month's entries, runs of empty months folded into one disc, and a scale anchored at the
// oldest month, so new entries never move the months below them.

import { describe, expect, it } from 'vitest';
import {
  buildTimeScale,
  discAt,
  discOf,
  FOLD_HEIGHT,
  MONTH_BASE,
  MONTH_STEP,
  monthHeight,
  monthOf,
  monthStart,
  yOf,
} from '../../web/src/brain/timescale.ts';

const t = (iso: string) => Date.parse(iso);
const NOW = t('2026-11-25T12:00:00Z');
const m = (iso: string) => monthOf(t(iso));
/** n entries in the middle of a month. */
const many = (iso: string, n: number) => Array.from({ length: n }, () => t(iso));

describe('the months on the cord', () => {
  it('stacks them oldest first, with this month on top', () => {
    const scale = buildTimeScale([t('2026-09-03T00:00:00Z'), t('2026-10-20T00:00:00Z'), t('2026-11-01T00:00:00Z')], NOW);
    expect(scale.discs.map((d) => [d.from, d.count])).toEqual([
      [m('2026-09-01'), 1],
      [m('2026-10-01'), 1],
      [m('2026-11-01'), 1],
    ]);
    expect(scale.discs[0]!.y0).toBe(0);
    for (let i = 1; i < scale.discs.length; i++) expect(scale.discs[i]!.y0).toBe(scale.discs[i - 1]!.y1);
    expect(scale.height).toBe(scale.discs.at(-1)!.y1);
  });

  it('makes a month taller by the same step for each tenfold of its entries', () => {
    expect(monthHeight(1)).toBe(MONTH_BASE);
    expect(monthHeight(10)).toBeCloseTo(MONTH_BASE + MONTH_STEP);
    expect(monthHeight(1000)).toBeCloseTo(MONTH_BASE + 3 * MONTH_STEP);
    const scale = buildTimeScale([...many('2026-09-15T00:00:00Z', 100), ...many('2026-10-15T00:00:00Z', 10)], NOW);
    const [sep, oct] = scale.discs;
    expect(sep!.y1 - sep!.y0).toBeCloseTo(MONTH_BASE + 2 * MONTH_STEP);
    expect(oct!.y1 - oct!.y0).toBeCloseTo(MONTH_BASE + MONTH_STEP);
  });

  it('folds a run of empty months into one thin disc, and keeps this month its own disc when it is empty', () => {
    const scale = buildTimeScale([t('2025-12-10T00:00:00Z'), t('2026-06-10T00:00:00Z')], NOW);
    expect(scale.discs.map((d) => [d.from, d.to, d.count, d.fold])).toEqual([
      [m('2025-12-01'), m('2025-12-01'), 1, false],
      [m('2026-01-01'), m('2026-05-01'), 0, true],
      [m('2026-06-01'), m('2026-06-01'), 1, false],
      [m('2026-07-01'), m('2026-10-01'), 0, true],
      [m('2026-11-01'), m('2026-11-01'), 0, false],
    ]);
    expect(scale.discs[1]!.y1 - scale.discs[1]!.y0).toBeCloseTo(FOLD_HEIGHT);
    expect(scale.discs.at(-1)!.y1 - scale.discs.at(-1)!.y0).toBeCloseTo(MONTH_BASE);
  });

  it('shows an empty record as this month alone', () => {
    expect(buildTimeScale([], NOW)).toEqual({
      discs: [{ from: m('2026-11-01'), to: m('2026-11-01'), count: 0, fold: false, y0: 0, y1: MONTH_BASE }],
      height: MONTH_BASE,
      undated: 0,
    });
  });

  it('counts the months in UTC, as the app dates entries', () => {
    // 23:30 on 31 March in New York is already April in UTC.
    expect(monthOf(t('2026-03-31T23:30:00-05:00'))).toBe(m('2026-04-01'));
    expect(monthStart(m('2026-04-01'))).toBe(t('2026-04-01T00:00:00Z'));
    expect(monthStart(m('2026-01-01') - 1)).toBe(t('2025-12-01T00:00:00Z'));
  });

  it('puts an entry dated after this month on this month, and counts an entry with no date apart', () => {
    const scale = buildTimeScale([t('2026-10-02T00:00:00Z'), t('2027-03-01T00:00:00Z'), Number.NaN, Infinity, 9e15], NOW);
    expect(scale.discs.map((d) => [d.from, d.count])).toEqual([
      [m('2026-10-01'), 1],
      [m('2026-11-01'), 1],
    ]);
    expect(scale.undated).toBe(3);
  });
});

describe('a stable scale', () => {
  const before = buildTimeScale([...many('2026-08-15T00:00:00Z', 30), ...many('2026-10-15T00:00:00Z', 5), t('2026-11-02T00:00:00Z')], NOW);
  const below = (s: ReturnType<typeof buildTimeScale>) => s.discs.slice(0, -1).map((d) => [d.from, d.y0, d.y1]);

  it('grows only this month when this month gets entries', () => {
    const after = buildTimeScale([...many('2026-08-15T00:00:00Z', 30), ...many('2026-10-15T00:00:00Z', 5), ...many('2026-11-02T00:00:00Z', 400)], NOW);
    expect(below(after)).toEqual(below(before));
    expect(after.height).toBeGreaterThan(before.height);
  });

  it('adds a disc on top when a new month starts, and moves nothing below it', () => {
    const next = buildTimeScale([...many('2026-08-15T00:00:00Z', 30), ...many('2026-10-15T00:00:00Z', 5), t('2026-11-02T00:00:00Z')], t('2026-12-01T09:00:00Z'));
    expect(next.discs.slice(0, before.discs.length).map((d) => [d.from, d.y0, d.y1])).toEqual(before.discs.map((d) => [d.from, d.y0, d.y1]));
    expect(next.discs.at(-1)!.from).toBe(m('2026-12-01'));
  });
});

describe('finding a time on the cord, and a disc by its height', () => {
  const scale = buildTimeScale([t('2026-01-10T00:00:00Z'), ...many('2026-06-15T00:00:00Z', 10)], NOW);

  it('places a time inside its own month, as far up as it is through the month', () => {
    const june = scale.discs[discOf(scale, m('2026-06-01'))]!;
    expect(yOf(scale, t('2026-06-01T00:00:00Z'))).toBeCloseTo(june.y0);
    expect(yOf(scale, t('2026-06-16T00:00:00Z'))).toBeCloseTo((june.y0 + june.y1) / 2);
  });

  it('runs upward with time, and places a time in a fold inside the fold', () => {
    const ys = ['2026-01-10', '2026-03-01', '2026-05-30', '2026-06-15', '2026-11-20'].map((d) => yOf(scale, t(`${d}T00:00:00Z`))!);
    for (let i = 1; i < ys.length; i++) expect(ys[i]!).toBeGreaterThan(ys[i - 1]!);
    const fold = scale.discs[discOf(scale, m('2026-03-01'))]!;
    expect(fold.fold).toBe(true);
    expect(ys[1]!).toBeGreaterThanOrEqual(fold.y0);
    expect(ys[1]!).toBeLessThanOrEqual(fold.y1);
  });

  it('puts a time before the first month at the bottom, one after this month at the top, and an undated one nowhere', () => {
    expect(yOf(scale, t('2020-01-01T00:00:00Z'))).toBe(0);
    expect(yOf(scale, t('2030-01-01T00:00:00Z'))).toBe(scale.height);
    expect(yOf(scale, Number.NaN)).toBeNull();
  });

  it('finds the disc at a height, and the nearest end off the cord', () => {
    for (let i = 0; i < scale.discs.length; i++) {
      const d = scale.discs[i]!;
      expect(discAt(scale, (d.y0 + d.y1) / 2)).toBe(i);
    }
    expect(discAt(scale, -5)).toBe(0);
    expect(discAt(scale, scale.height + 5)).toBe(scale.discs.length - 1);
  });
});
