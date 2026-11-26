// The cord's calendar (UX audit item 21): the record's months stacked as discs, the oldest at the bottom and this
// month at the top. A month's disc grows with the log of its entries, and a run of empty months folds into one thin
// disc. The scale is anchored at the oldest month, so new entries only grow the top: past months keep their place
// until an older entry arrives. Months are UTC, as format.ts dates entries. Heights are in the cord's own units; the
// body layout scales them to the column.

/** A month with no entries, this month included, and a month with one entry. */
export const MONTH_BASE = 1;
/** What each tenfold of a month's entries adds to its height. */
export const MONTH_STEP = 0.5;
/** A fold of empty months, however many it holds. */
export const FOLD_HEIGHT = 0.4;

/** A month as one number: UTC year × 12 + month (0 to 11). */
export function monthOf(t: number): number {
  const d = new Date(t);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** The first instant of a month number. */
export function monthStart(month: number): number {
  return Date.UTC(Math.floor(month / 12), month % 12, 1);
}

export interface Disc {
  /** The first month it covers and the last: one month for a month's own disc, a span for a fold. */
  from: number;
  to: number;
  /** Its entries. A fold has none. */
  count: number;
  /** A run of empty months folded into one disc. This month's disc is never a fold, even when it is empty. */
  fold: boolean;
  /** Its bottom and top, in cord units. */
  y0: number;
  y1: number;
}

export interface TimeScale {
  /** Oldest first: the bottom disc first, this month's last. */
  discs: Disc[];
  height: number;
  /** Entries with no usable date, which have no place on the cord. */
  undated: number;
}

/** A time a Date can hold, so it has a month. */
function dated(t: number): boolean {
  return Number.isFinite(t) && Math.abs(t) <= 8.64e15;
}

/** A month's height from its entries. */
export function monthHeight(count: number): number {
  return count > 0 ? MONTH_BASE + MONTH_STEP * Math.log10(count) : MONTH_BASE;
}

/**
 * The discs for these entry times, up to the month of `now`. An entry dated after this month (a clock or a typo in an
 * import) counts in this month, at the top.
 */
export function buildTimeScale(times: Iterable<number>, now: number): TimeScale {
  const top = monthOf(now);
  const counts = new Map<number, number>();
  let undated = 0;
  let first = top;
  for (const t of times) {
    if (!dated(t)) {
      undated++;
      continue;
    }
    const m = Math.min(monthOf(t), top);
    counts.set(m, (counts.get(m) ?? 0) + 1);
    if (m < first) first = m;
  }
  const discs: Disc[] = [];
  let y = 0;
  for (let m = first; m <= top; m++) {
    const count = counts.get(m) ?? 0;
    if (count === 0 && m !== top) {
      // An empty month: it joins the fold just below (the months run one by one, so that fold ends at m - 1).
      const last = discs.at(-1);
      if (last?.fold) last.to = m;
      else {
        discs.push({ from: m, to: m, count: 0, fold: true, y0: y, y1: y + FOLD_HEIGHT });
        y += FOLD_HEIGHT;
      }
      continue;
    }
    const h = monthHeight(count);
    discs.push({ from: m, to: m, count, fold: false, y0: y, y1: y + h });
    y += h;
  }
  return { discs, height: y, undated };
}

/** The disc a month falls in, by its index in `discs`; -1 before the first, the top disc after the last. */
export function discOf(scale: TimeScale, month: number): number {
  const { discs } = scale;
  if (month < discs[0]!.from) return -1;
  let lo = 0;
  let hi = discs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (discs[mid]!.from <= month) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Where a time sits on the cord: inside its disc, as far up as it is through the disc's months. The bottom for a
 * time before the first month, the top for one after this month, and null for an entry with no usable date.
 */
export function yOf(scale: TimeScale, t: number): number | null {
  if (!dated(t)) return null;
  const i = discOf(scale, monthOf(t));
  if (i < 0) return 0;
  const d = scale.discs[i]!;
  const start = monthStart(d.from);
  const end = monthStart(d.to + 1);
  const f = Math.min(1, Math.max(0, (t - start) / (end - start)));
  return d.y0 + (d.y1 - d.y0) * f;
}

/** The disc at a height on the cord, by its index; the nearest end when the height is off the cord. */
export function discAt(scale: TimeScale, y: number): number {
  const { discs } = scale;
  let lo = 0;
  let hi = discs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (discs[mid]!.y0 <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
