// Small pure helpers the charts share: smoothing, scales and tick values.

/** A centred moving average over 2k+1 points; the window shrinks at the ends. k = 0 returns a copy. */
export function smooth(values: readonly number[], k: number): number[] {
  if (k <= 0) return [...values];
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(values.length - 1, i + k); j++) {
      sum += values[j]!;
      n++;
    }
    return sum / n;
  });
}

/** Maps a value to 0..1 of the axis, on a linear or log scale. Log uses log(1 + v) so zero stays at the bottom. */
export function scale(v: number, max: number, log: boolean): number {
  if (max <= 0) return 0;
  return log ? Math.log1p(Math.max(0, v)) / Math.log1p(max) : Math.max(0, v) / max;
}

/** A round number at or above max, for the top of an axis: 1, 2 or 5 times a power of ten. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

/** Labels for a category axis that has no room for all of them: every nth, so at most `room` show. */
export function sparseLabels(count: number, room: number): Set<number> {
  const step = Math.max(1, Math.ceil(count / Math.max(1, room)));
  const out = new Set<number>();
  for (let i = 0; i < count; i += step) out.add(i);
  return out;
}
