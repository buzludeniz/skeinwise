// Timeline: entries per week, split by source or speaker. Drag across a span to light its points in the strip below
// the chart, the brain's points laid in one lane per source in time order.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Brain, X } from 'lucide-preact';
import { go, light, message } from '../actions.ts';
import { api, qs } from '../api.ts';
import { useBrainScene } from '../brain/useBrain.ts';
import { fmtDate, fmtNum, plural, speakerName } from '../format.ts';
import { useApp } from '../store.ts';
import { palette, pointColors, theme } from '../themes.ts';
import type { Timeline } from '../types.ts';
import { Button, Empty, Segmented } from '../ui/common.tsx';
import { useWidth } from '../ui/useWidth.ts';

const WEEK = 7 * 86_400_000;
const MAX_SERIES = 8;

/** The series to draw: the biggest few, and the rest folded into one. */
function fold(t: Timeline): { key: string; counts: number[]; total: number }[] {
  const sorted = [...t.series].sort((a, b) => b.total - a.total);
  if (sorted.length <= MAX_SERIES) return sorted;
  const head = sorted.slice(0, MAX_SERIES - 1);
  const rest = sorted.slice(MAX_SERIES - 1);
  const counts = t.weeks.map((_, i) => rest.reduce((n, s) => n + (s.counts[i] ?? 0), 0));
  return [...head, { key: `${rest.length} more`, counts, total: rest.reduce((n, s) => n + s.total, 0) }];
}

export function TimelineView() {
  const strip = useRef<HTMLDivElement>(null);
  const chartBox = useRef<HTMLDivElement>(null);
  const brain = useApp((s) => s.brain);
  const revision = useApp((s) => s.revision);
  const themeKey = useApp((s) => s.config?.appearance.theme ?? 'dusk');
  const paletteKey = useApp((s) => s.config?.appearance.palette ?? 'ember');
  const compact = useApp((s) => s.compact);
  const [by, setBy] = useState<'source' | 'speaker'>('source');
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [span, setSpan] = useState<[number, number] | null>(null);
  const drag = useRef<number | null>(null);
  const width = useWidth(chartBox);

  useEffect(() => {
    let live = true;
    api.get<Timeline>(`timeline${qs({ by })}`).then(
      (d) => live && setData(d),
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [by, revision]);

  const weeks = data?.weeks ?? [];
  const range = useMemo(() => {
    if (!span || !weeks.length) return null;
    const [a, b] = span[0] <= span[1] ? span : [span[1], span[0]];
    return { from: Date.parse(weeks[a]!), to: Date.parse(weeks[b]!) + WEEK, a, b };
  }, [span, weeks]);

  const spanIds = useMemo(() => {
    if (!range || !brain) return null;
    const ids = new Set<number>();
    for (const p of brain.points) if (p[7] >= range.from && p[7] < range.to) ids.add(p[0]);
    return ids;
  }, [range, brain]);

  const { ok, loadFailed } = useBrainScene(strip, 'strip', spanIds);

  const series = useMemo(() => (data ? fold(data) : []), [data]);
  const colors = useMemo(() => {
    const c = pointColors(palette(paletteKey), theme(themeKey));
    return series.map((_, i) => c[i % c.length]!);
  }, [series, paletteKey, themeKey]);

  if (error) return <Empty title="Couldn't load the timeline">{error}</Empty>;

  const n = weeks.length;
  const H = compact ? 220 : 280;
  const pad = { l: 34, r: 8, t: 10, b: 24 };
  const plotW = width - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const stackMax = Math.max(1, ...weeks.map((_, i) => series.reduce((s, x) => s + (x.counts[i] ?? 0), 0)));
  const bw = n ? plotW / n : 0;
  const y = (v: number) => pad.t + plotH - (v / stackMax) * plotH;
  const indexAt = (clientX: number) => {
    const box = chartBox.current!.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor((clientX - box.left - pad.l) / bw)));
  };

  const preset = (k: 'month' | 'year' | 'all') => {
    if (!n) return;
    if (k === 'all') setSpan([0, n - 1]);
    else setSpan([Math.max(0, n - (k === 'month' ? 5 : 52)), n - 1]);
  };
  const activePreset = !span ? null : span[0] === 0 && span[1] === n - 1 ? 'all' : span[1] === n - 1 && span[0] === n - 5 ? 'month' : span[1] === n - 1 && span[0] === n - 52 ? 'year' : null;

  const years: { x: number; label: string }[] = [];
  weeks.forEach((w, i) => {
    if (i === 0 || w.slice(0, 4) !== weeks[i - 1]!.slice(0, 4)) years.push({ x: pad.l + i * bw, label: w.slice(0, 4) });
  });
  const grid = [0.5, 1].map((f) => Math.round(stackMax * f));

  return (
    <section class="view timeline" aria-label="Timeline">
      <div class="strip" ref={strip} aria-label="Every entry by source over time, with the span lit">
        {loadFailed ? (
          // The scene's file is gone, most often after a rebuild: not a WebGL problem, and a reload would lose the token.
          <p class="soft pad">
            The strip didn't load: Skeinwise was probably updated after this page opened. Open a new tab at the address
            Skeinwise printed when it started.
          </p>
        ) : (
          !ok && <p class="soft pad">This browser can't draw the strip.</p>
        )}
      </div>
      <div class="timeline-body">
        <header class="view-head">
          <h1>Timeline</h1>
          <Segmented
            label="Split by"
            options={[
              ['source', 'By source'],
              ['speaker', 'By speaker'],
            ]}
            value={by}
            onChange={setBy}
          />
          <div class="row">
            <button type="button" class={`chip${activePreset === 'month' ? ' on' : ''}`} onClick={() => preset('month')} title="The record's last month">
              Last month
            </button>
            <button type="button" class={`chip${activePreset === 'year' ? ' on' : ''}`} onClick={() => preset('year')} title="The record's last year">
              Last year
            </button>
            <button type="button" class={`chip${activePreset === 'all' ? ' on' : ''}`} onClick={() => preset('all')}>
              All
            </button>
          </div>
        </header>

        <div class="span-line" role="status">
          {range && spanIds ? (
            <>
              <span>
                <strong>{plural(spanIds.size, 'entry', 'entries')}</strong> from {fmtDate(range.from)} to {fmtDate(range.to - 86_400_000)}
              </span>
              <Button icon={Brain} small onClick={() => {
                light(spanIds, `${fmtDate(range.from)} – ${fmtDate(range.to - 86_400_000)}`);
                go('brain');
              }}>
                Show in the brain
              </Button>
              <Button icon={X} small kind="quiet" aria-label="Clear the span" onClick={() => setSpan(null)} />
            </>
          ) : (
            <span class="soft">Drag across the chart to pick a span. Its entries light up in the brain above.</span>
          )}
        </div>

        <div
          class="chart"
          ref={chartBox}
          onPointerDown={(e) => {
            if (!n) return;
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = indexAt(e.clientX);
            setSpan([drag.current, drag.current]);
          }}
          onPointerMove={(e) => {
            if (drag.current === null) return;
            setSpan([drag.current, indexAt(e.clientX)]);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          {!data ? (
            <p class="soft pad">Counting weeks…</p>
          ) : n === 0 ? (
            <Empty title="Nothing to chart yet" />
          ) : (
            <svg width={width} height={H} role="img" aria-label={`Entries per week, ${fmtDate(weeks[0]!)} to ${fmtDate(weeks[n - 1]!)}`}>
              {grid.map((g) => (
                <g key={g}>
                  <line x1={pad.l} x2={width - pad.r} y1={y(g)} y2={y(g)} class="grid" />
                  <text x={pad.l - 6} y={y(g) + 4} class="axis" text-anchor="end">
                    {fmtNum(g)}
                  </text>
                </g>
              ))}
              {weeks.map((w, i) => {
                let acc = 0;
                return (
                  <g key={w}>
                    {series.map((s, si) => {
                      const v = s.counts[i] ?? 0;
                      if (!v) return null;
                      const y0 = y(acc);
                      acc += v;
                      return <rect key={si} x={pad.l + i * bw + 0.5} width={Math.max(1, bw - 1)} y={y(acc)} height={y0 - y(acc)} fill={colors[si]} />;
                    })}
                  </g>
                );
              })}
              {range && (
                <rect class="brush" x={pad.l + range.a * bw} width={(range.b - range.a + 1) * bw} y={pad.t} height={plotH} />
              )}
              {years.map((t) => (
                <g key={t.label}>
                  <line x1={t.x} x2={t.x} y1={pad.t + plotH} y2={pad.t + plotH + 5} class="tick" />
                  <text x={t.x + 3} y={H - 6} class="axis">
                    {t.label}
                  </text>
                </g>
              ))}
            </svg>
          )}
        </div>
        <ul class="chart-legend" aria-label="Series">
          {series.map((s, i) => (
            <li key={s.key}>
              <span class="dot" style={{ background: colors[i] }} aria-hidden="true" />
              {by === 'speaker' ? speakerName(s.key) : s.key} <span class="soft">{fmtNum(s.total)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
