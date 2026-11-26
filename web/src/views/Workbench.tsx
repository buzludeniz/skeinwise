// The Workbench: the table builder (two properties on the axes, a third as a filter, six forms) and Activity.

import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Brain, Save, X } from 'lucide-preact';
import { changed, go, light, message, openEntry, openThread, saveConfig, toast } from '../actions.ts';
import { api, qs } from '../api.ts';
import { niceMax, scale, smooth, sparseLabels } from '../chart.ts';
import { fmtDate, fmtMonth, fmtNum, plural, speakerName } from '../format.ts';
import { setState, useApp } from '../store.ts';
import { palette, pointColors, theme } from '../themes.ts';
import type { EntryRow, LabView, Series, Table, TableProp } from '../types.ts';
import { Button, Empty, Segmented, Select } from '../ui/common.tsx';
import { useWidth } from '../ui/useWidth.ts';

const PROPS: [TableProp, string][] = [
  ['time', 'Time'],
  ['folder', 'Folder'],
  ['project', 'Project'],
  ['hub', 'Hub'],
  ['source', 'Source'],
  ['speaker', 'Speaker'],
  ['tag', 'Tag'],
];

type Form = 'table' | 'heatmap' | 'bars' | 'stacked' | 'lines' | 'dots';
const FORMS: [Form, string][] = [
  ['table', 'Table'],
  ['heatmap', 'Heatmap'],
  ['bars', 'Bars'],
  ['stacked', 'Stacked bars'],
  ['lines', 'Lines'],
  ['dots', 'Dots'],
];

export function valueLabel(prop: string, v: string): string {
  if (prop === 'time' && /^\d{4}-\d{2}$/.test(v)) return fmtMonth(v);
  if (prop === 'speaker') return speakerName(v);
  return v;
}

function useSeriesColors(n: number): string[] {
  const themeKey = useApp((s) => s.config?.appearance.theme ?? 'dusk');
  const paletteKey = useApp((s) => s.config?.appearance.palette ?? 'ember');
  return useMemo(() => {
    const c = pointColors(palette(paletteKey), theme(themeKey));
    return Array.from({ length: n }, (_, i) => c[i % c.length]!);
  }, [n, themeKey, paletteKey]);
}

interface Cell {
  xi: number;
  yi: number;
}

/** Grid forms: a plain table, or a heatmap with the counts shaded. */
export function Grid({ t, heat, onCell }: { t: Table; heat: boolean; onCell: (c: Cell) => void }) {
  return (
    <div class="grid-wrap">
      <table class={`workbench-table${heat ? ' heat' : ''}`}>
        <thead>
          <tr>
            <th scope="col">
              <span class="sr-only">
                {t.y} by {t.x}
              </span>
            </th>
            {t.xs.map((x) => (
              <th key={x} scope="col">
                {valueLabel(t.x, x)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {t.ys.map((y, yi) => (
            <tr key={y}>
              <th scope="row">{valueLabel(t.y, y)}</th>
              {t.xs.map((x, xi) => {
                const v = t.cells[yi]?.[xi] ?? 0;
                const share = t.max ? v / t.max : 0;
                return (
                  <td key={x} style={heat && v ? { background: `color-mix(in srgb, var(--accent) ${Math.round(12 + share * 78)}%, transparent)` } : undefined}>
                    {v ? (
                      <button type="button" class={heat && share > 0.55 ? 'on-strong' : ''} onClick={() => onCell({ xi, yi })} aria-label={`${fmtNum(v)}: ${valueLabel(t.y, y)}, ${valueLabel(t.x, x)}`}>
                        {fmtNum(v)}
                      </button>
                    ) : (
                      <span class="zero">·</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** SVG forms: bars, stacked bars, lines and dots, with x along the bottom and one colour per y value. */
export function Plot({ t, form, onCell }: { t: Table; form: Form; onCell: (c: Cell) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const colors = useSeriesColors(t.ys.length);
  const H = 300;
  const pad = { l: 40, r: 10, t: 12, b: 46 };
  const pw = width - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const nx = t.xs.length;
  const ny = t.ys.length;
  const colTotals = t.xs.map((_, xi) => t.ys.reduce((s, _y, yi) => s + (t.cells[yi]?.[xi] ?? 0), 0));
  const top = niceMax(form === 'stacked' ? Math.max(0, ...colTotals) : t.max);
  const y = (v: number) => pad.t + ph - (v / top) * ph;
  const band = nx ? pw / nx : 0;
  const shown = sparseLabels(nx, Math.floor(pw / 64));
  const marks: JSX.Element[] = [];

  t.xs.forEach((_, xi) => {
    const x0 = pad.l + xi * band;
    let acc = 0;
    t.ys.forEach((_y, yi) => {
      const v = t.cells[yi]?.[xi] ?? 0;
      if (!v) return;
      const label = `${fmtNum(v)}: ${valueLabel(t.y, t.ys[yi]!)}, ${valueLabel(t.x, t.xs[xi]!)}`;
      const click = () => onCell({ xi, yi });
      if (form === 'bars') {
        const w = Math.max(1, (band * 0.8) / ny);
        marks.push(<rect key={`${xi}-${yi}`} class="mark" x={x0 + band * 0.1 + yi * w} y={y(v)} width={Math.max(1, w - 0.5)} height={pad.t + ph - y(v)} fill={colors[yi]} onClick={click}><title>{label}</title></rect>);
      } else if (form === 'stacked') {
        const y1 = y(acc);
        acc += v;
        marks.push(<rect key={`${xi}-${yi}`} class="mark" x={x0 + band * 0.12} y={y(acc)} width={Math.max(1, band * 0.76)} height={y1 - y(acc)} fill={colors[yi]} onClick={click}><title>{label}</title></rect>);
      } else if (form === 'dots') {
        const cy = pad.t + (ny > 1 ? (yi / (ny - 1)) * ph : ph / 2);
        const r = 2 + Math.sqrt(v / Math.max(1, t.max)) * Math.min(band, ph / Math.max(1, ny)) * 0.48;
        marks.push(<circle key={`${xi}-${yi}`} class="mark" cx={x0 + band / 2} cy={cy} r={r} fill={colors[yi]} fill-opacity={0.8} onClick={click}><title>{label}</title></circle>);
      }
    });
  });

  if (form === 'lines') {
    t.ys.forEach((_y, yi) => {
      const pts = t.xs.map((_, xi) => [pad.l + xi * band + band / 2, y(t.cells[yi]?.[xi] ?? 0)] as const);
      marks.push(<polyline key={`l${yi}`} points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={colors[yi]} stroke-width={2} />);
      pts.forEach(([cx, cy], xi) => {
        const v = t.cells[yi]?.[xi] ?? 0;
        if (v) marks.push(<circle key={`p${yi}-${xi}`} class="mark" cx={cx} cy={cy} r={3.5} fill={colors[yi]} onClick={() => onCell({ xi, yi })}><title>{`${fmtNum(v)}: ${valueLabel(t.y, t.ys[yi]!)}, ${valueLabel(t.x, t.xs[xi]!)}`}</title></circle>);
      });
    });
  }

  return (
    <div class="plot" ref={box}>
      <svg width={width} height={H} role="img" aria-label={`${FORMS.find(([f]) => f === form)?.[1]} of entries by ${t.x} and ${t.y}`}>
        {form !== 'dots' &&
          [0.5, 1].map((f) => (
            <g key={f}>
              <line class="grid" x1={pad.l} x2={width - pad.r} y1={y(top * f)} y2={y(top * f)} />
              <text class="axis" x={pad.l - 6} y={y(top * f) + 4} text-anchor="end">
                {fmtNum(top * f)}
              </text>
            </g>
          ))}
        {marks}
        {t.xs.map((x, xi) =>
          shown.has(xi) ? (
            <text key={x} class="axis" x={pad.l + xi * band + band / 2} y={H - pad.b + 16} text-anchor="middle">
              {valueLabel(t.x, x).slice(0, 14)}
            </text>
          ) : null,
        )}
      </svg>
      <ul class="chart-legend" aria-label={`Colours: ${t.y}`}>
        {t.ys.map((v, i) => (
          <li key={v}>
            <span class="dot" style={{ background: colors[i] }} aria-hidden="true" />
            {valueLabel(t.y, v)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CellEntries({ q, label, onClose }: { q: Record<string, string>; label: string; onClose: () => void }) {
  const [data, setData] = useState<{ total: number; entries: EntryRow[] } | null>(null);
  useEffect(() => {
    setData(null);
    api.get<{ total: number; entries: EntryRow[] }>(`table/cell${qs(q)}`).then(setData, (e: unknown) => toast(message(e), { tone: 'error' }));
  }, [JSON.stringify(q)]);
  return (
    <section class="card cell-entries" aria-label={`Entries: ${label}`}>
      <header class="row">
        <h3>{label}</h3>
        {data && <span class="soft">{plural(data.total, 'entry', 'entries')}</span>}
        {data && data.total > 0 && (
          <Button icon={Brain} small onClick={() => {
            light(data.entries.map((e) => e.id), label);
            go('brain');
          }}>
            Light in the brain
          </Button>
        )}
        <Button icon={X} small kind="quiet" aria-label="Close the list" onClick={onClose} />
      </header>
      {!data ? (
        <p class="soft">Gathering…</p>
      ) : (
        <ul class="item-list">
          {data.entries.map((e) => (
            <li key={e.id}>
              <button type="button" class="item" onClick={() => (e.threadId ? openThread(e.threadId, e.id) : openEntry(e.id))}>
                <span class="item-title">{e.title || 'Untitled'}</span>
                <span class="item-meta">
                  {fmtDate(e.createdAt)} · {speakerName(e.speaker)} · {e.source}
                </span>
              </button>
            </li>
          ))}
          {data.total > data.entries.length && <li class="soft small pad">The first {data.entries.length} are shown.</li>}
        </ul>
      )}
    </section>
  );
}

function TableBuilder() {
  const views = useApp((s) => s.config?.lab.views ?? []);
  const revision = useApp((s) => s.revision);
  const [x, setX] = useState<TableProp>('time');
  const [y, setY] = useState<TableProp>('source');
  const [fProp, setFProp] = useState<TableProp | 'none'>('none');
  const [fValue, setFValue] = useState('');
  const [form, setForm] = useState<Form>('heatmap');
  const [t, setT] = useState<Table | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cell, setCell] = useState<Cell | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const filter = fProp !== 'none' && fValue.trim() ? `${fProp}:${fValue.trim()}` : '';

  useEffect(() => {
    let live = true;
    setCell(null);
    api.get<Table>(`table${qs({ x, y, filter: filter || null })}`).then(
      (d) => live && (setT(d), setError(null)),
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [x, y, filter, revision]);

  const apply = (v: LabView) => {
    setX(v.x as TableProp);
    setY(v.y as TableProp);
    setForm(v.form as Form);
    const at = v.filter.indexOf(':');
    if (at > 0) {
      setFProp(v.filter.slice(0, at) as TableProp);
      setFValue(v.filter.slice(at + 1));
    } else {
      setFProp('none');
      setFValue('');
    }
  };

  const save = async (name: string) => {
    const view: LabView = { name: name.trim(), x, y, filter, form };
    if (!view.name) return;
    const next = [...views.filter((v) => v.name !== view.name), view];
    if (await saveConfig({ lab: { views: next } })) toast(`Saved the view “${view.name}”.`, { tone: 'ok' });
    setNaming(null);
  };

  const remove = (v: LabView) => {
    const before = views;
    void saveConfig({ lab: { views: views.filter((w) => w !== v) } });
    changed(`Removed the view “${v.name}”.`, `Bring back the view “${v.name}”`, async () => {
      await saveConfig({ lab: { views: before } });
    });
  };

  return (
    <div class="workbench-builder">
      <div class="workbench-controls">
        <Select label="Across" value={x} options={PROPS} onChange={setX} />
        <Select label="Down" value={y} options={PROPS} onChange={setY} />
        <Select label="Only where" value={fProp} options={[['none', 'Anything'], ...PROPS]} onChange={setFProp} />
        {fProp !== 'none' && (
          <label class="field field-inline">
            <span class="sr-only">is</span>
            <input value={fValue} placeholder={fProp === 'speaker' ? 'you' : fProp === 'time' ? '2026-03' : 'value'} onInput={(e) => setFValue((e.currentTarget as HTMLInputElement).value)} />
          </label>
        )}
      </div>
      <div class="row wrap">
        <Segmented label="Form" options={FORMS} value={form} onChange={setForm} />
        {naming === null ? (
          <Button icon={Save} small kind="quiet" onClick={() => setNaming('')}>
            Save view
          </Button>
        ) : (
          <form
            class="row"
            onSubmit={(e) => {
              e.preventDefault();
              void save(naming);
            }}
          >
            <input autofocus aria-label="Name of the view" placeholder="Name" value={naming} onInput={(e) => setNaming((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
            <Button small kind="primary" type="submit">
              Save
            </Button>
          </form>
        )}
      </div>
      {views.length > 0 && (
        <ul class="saved-views" aria-label="Saved views">
          {views.map((v) => (
            <li key={v.name} class="chip-pair">
              <button type="button" class="chip" onClick={() => apply(v)}>
                {v.name}
              </button>
              <button type="button" class="chip chip-x" aria-label={`Remove ${v.name}`} onClick={() => remove(v)}>
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <Empty title="Couldn't count">{error}</Empty>
      ) : !t ? (
        <p class="soft pad">Counting…</p>
      ) : t.total === 0 ? (
        <Empty title="No entries match">
          <p>Try another filter.</p>
        </Empty>
      ) : (
        <>
          <p class="soft small">
            {plural(t.total, 'entry', 'entries')} · {t.ys.length} × {t.xs.length}. Click a {form === 'table' || form === 'heatmap' ? 'cell' : 'mark'} to list its entries.
          </p>
          {form === 'table' || form === 'heatmap' ? <Grid t={t} heat={form === 'heatmap'} onCell={setCell} /> : <Plot t={t} form={form} onCell={setCell} />}
          {cell && (
            <CellEntries
              q={{ x, xv: t.xs[cell.xi]!, y, yv: t.ys[cell.yi]!, ...(filter ? { filter } : {}) }}
              label={`${valueLabel(y, t.ys[cell.yi]!)} · ${valueLabel(x, t.xs[cell.xi]!)}`}
              onClose={() => setCell(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

function ActivityLines() {
  const revision = useApp((s) => s.revision);
  const [by, setBy] = useState<'source' | 'speaker' | 'folder'>('source');
  const [log, setLog] = useState(false);
  const [k, setK] = useState(1);
  const [data, setData] = useState<{ months: string[]; lines: Series[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const lines = useMemo(() => (data ? data.lines.slice(0, 10) : []), [data]);
  const colors = useSeriesColors(lines.length);

  useEffect(() => {
    let live = true;
    api.get<{ months: string[]; lines: Series[] }>(`tides${qs({ by })}`).then(
      (d) => live && (setData(d), setError(null)),
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [by, revision]);

  if (error) return <Empty title="Couldn't draw the activity lines">{error}</Empty>;
  const months = data?.months ?? [];
  const H = 320;
  const pad = { l: 40, r: 10, t: 12, b: 28 };
  const pw = width - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const smoothed = lines.map((l) => smooth(l.counts, k));
  const max = niceMax(Math.max(0, ...smoothed.flat()));
  const xAt = (i: number) => pad.l + (months.length > 1 ? (i / (months.length - 1)) * pw : pw / 2);
  const yAt = (v: number) => pad.t + ph - scale(v, max, log) * ph;
  const shown = sparseLabels(months.length, Math.floor(pw / 70));
  const ticks = log ? [1, 10, 100, 1000].filter((v) => v <= max) : [max / 2, max];

  return (
    <div class="activity">
      <div class="row wrap">
        <Segmented
          label="Lines by"
          options={[
            ['source', 'Source'],
            ['speaker', 'Speaker'],
            ['folder', 'Folder'],
          ]}
          value={by}
          onChange={setBy}
        />
        <Segmented
          label="Scale"
          options={[
            ['linear', 'Linear'],
            ['log', 'Log'],
          ]}
          value={log ? 'log' : 'linear'}
          onChange={(v) => setLog(v === 'log')}
        />
        <label class="range">
          <span>Smoothing</span>
          <input type="range" min={0} max={6} step={1} value={k} onInput={(e) => setK(Number((e.currentTarget as HTMLInputElement).value))} aria-valuetext={k ? `${k * 2 + 1} months` : 'None'} />
          <span class="soft small">{k ? `${k * 2 + 1} months` : 'None'}</span>
        </label>
      </div>
      <div class="plot" ref={box}>
        {!data ? (
          <p class="soft pad">Drawing…</p>
        ) : months.length === 0 ? (
          <Empty title="Nothing to draw yet" />
        ) : (
          <svg width={width} height={H} role="img" aria-label={`Entries per month by ${by}, ${fmtMonth(months[0]!)} to ${fmtMonth(months.at(-1)!)}`}>
            {ticks.map((v) => (
              <g key={v}>
                <line class="grid" x1={pad.l} x2={width - pad.r} y1={yAt(v)} y2={yAt(v)} />
                <text class="axis" x={pad.l - 6} y={yAt(v) + 4} text-anchor="end">
                  {fmtNum(Math.round(v))}
                </text>
              </g>
            ))}
            {smoothed.map((vals, li) => (
              <polyline key={lines[li]!.key} points={vals.map((v, i) => `${xAt(i)},${yAt(v)}`).join(' ')} fill="none" stroke={colors[li]} stroke-width={2} stroke-linejoin="round">
                <title>{lines[li]!.key}</title>
              </polyline>
            ))}
            {months.map((m, i) =>
              shown.has(i) ? (
                <text key={m} class="axis" x={xAt(i)} y={H - 8} text-anchor="middle">
                  {fmtMonth(m)}
                </text>
              ) : null,
            )}
          </svg>
        )}
      </div>
      <ul class="chart-legend" aria-label="Lines">
        {lines.map((l, i) => (
          <li key={l.key}>
            <span class="dot" style={{ background: colors[i] }} aria-hidden="true" />
            {by === 'speaker' ? speakerName(l.key) : l.key} <span class="soft">{fmtNum(l.total)}</span>
          </li>
        ))}
        {data && data.lines.length > lines.length && <li class="soft">and {data.lines.length - lines.length} smaller</li>}
      </ul>
    </div>
  );
}

export function Workbench() {
  const tab = useApp((s) => s.workbenchTab);
  return (
    <section class="view workbench" aria-label="Workbench">
      <header class="view-head">
        <h1>Workbench</h1>
        <div class="tabs" role="tablist" aria-label="Workbench">
          <button type="button" role="tab" aria-selected={tab === 'table'} class={tab === 'table' ? 'on' : ''} onClick={() => setState({ workbenchTab: 'table' })}>
            Table builder
          </button>
          <button type="button" role="tab" aria-selected={tab === 'activity'} class={tab === 'activity' ? 'on' : ''} onClick={() => setState({ workbenchTab: 'activity' })}>
            Activity
          </button>
        </div>
      </header>
      {tab === 'table' ? <TableBuilder /> : <ActivityLines />}
    </section>
  );
}
