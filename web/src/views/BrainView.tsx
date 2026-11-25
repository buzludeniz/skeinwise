// The Brain: the record as a glowing point cloud, with search, Fit, view settings, layouts and the legend.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Focus, Info, Plus, Search, SlidersHorizontal, X } from 'lucide-preact';
import { clearLight, go, light, message, saveConfig, setGrouping, setLayout, toast } from '../actions.ts';
import { api, qs } from '../api.ts';
import { useBrainModel, useBrainScene } from '../brain/useBrain.ts';
import { fmtDate, fmtNum, plural, speakerName } from '../format.ts';
import { type ColourGrouping, GROUPING_LABELS } from '../groups.ts';
import type { Layout } from '../layout.ts';
import { setState, useApp } from '../store.ts';
import type { Hit } from '../types.ts';
import { Button, Empty, Segmented, Select, Switch } from '../ui/common.tsx';

const LAYOUTS: [Layout, string][] = [
  ['brain', 'Brain'],
  ['rings', 'Year rings'],
  ['clusters', 'Clusters'],
];

const KIND_NAMES = ['Message', 'Note', 'File'];

export function BrainView() {
  const host = useRef<HTMLDivElement>(null);
  const { scene, model, ok, hover } = useBrainScene(host, 'full');
  const brain = useApp((s) => s.brain);
  const layout = useApp((s) => s.layout);
  const lit = useApp((s) => s.lit);
  const compact = useApp((s) => s.compact);
  const clip = useApp((s) => s.clip);
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(layout === 'rings');

  useEffect(() => setHelp(layout === 'rings'), [layout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]');
      if (e.key === 'Escape' && lit && !document.querySelector('.side-panel, .modal-open')) clearLight();
      if (!typing && (e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target as HTMLElement).closest('canvas')) scene.fit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lit]);

  const empty = brain && brain.points.length === 0;
  const point = hover && brain && model ? brain.points[hover.index] : null;
  const hub = hover && model && !point ? model.hubs.find((h) => h.index === hover.index) : null;

  return (
    <section class="view brain-view" aria-label="Brain">
      <div class="brain-host" ref={host} />
      {!ok && (
        <div class="brain-fallback">
          <Empty title="This browser can't draw the brain">
            <p>It needs WebGL. Everything else works: try Navigator or Numbers.</p>
          </Empty>
        </div>
      )}
      {empty && (
        <div class="brain-fallback">
          <Empty title="Nothing woven yet">
            <p>Add an export, a note folder or your agent history, and the brain fills in point by point.</p>
            <Button icon={Plus} kind="primary" onClick={() => go('add')}>
              Add files or a source
            </Button>
          </Empty>
        </div>
      )}

      <div class="brain-top">
        {lit && (
          <div class="lit-chip" role="status">
            <span>
              {lit.label} · {plural(lit.ids.size, 'entry', 'entries')}
            </span>
            <Button icon={X} kind="quiet" small aria-label="Clear the lit points" title="Clear (Esc)" onClick={clearLight} />
          </div>
        )}
        <div class="brain-tools">
          <BrainSearch />
          <Button icon={Focus} kind="quiet" title="Frame the whole cloud (F)" onClick={() => scene.fit()}>
            {compact ? undefined : 'Fit'}
          </Button>
          <Button
            icon={SlidersHorizontal}
            kind="quiet"
            aria-label="View settings"
            aria-expanded={settings}
            title="View settings"
            onClick={() => setSettings(!settings)}
          />
        </div>
      </div>
      {settings && <ViewSettings onClose={() => setSettings(false)} />}

      <div class="brain-layouts">
        <Segmented label="Layout" options={LAYOUTS} value={layout} onChange={setLayout} />
        {layout !== 'brain' && (
          <Button icon={Info} kind="quiet" small aria-expanded={help} onClick={() => setHelp(!help)}>
            How to read this
          </Button>
        )}
      </div>
      {help && layout !== 'brain' && <ReadingBox layout={layout} onClose={() => setHelp(false)} />}

      {point && hover && !clip && (
        <div class="hover-card" style={{ transform: `translate(${Math.round(hover.x + 14)}px, ${Math.round(hover.y - 12)}px)` }} role="tooltip">
          <p class="hover-title">{point[8] || 'Untitled'}</p>
          <p class="hover-meta">
            {fmtDate(point[7])} · {brain!.sources.find((s) => s.id === point[3])?.label ?? 'Unknown source'}
          </p>
          <p class="hover-meta">
            {KIND_NAMES[point[1]]} · {speakerName(brain!.speakers[point[2]] ?? '')}
          </p>
          <p class="hover-hint">Double-click to open</p>
        </div>
      )}
      {hub && hover && !clip && (
        <div class="hover-card" style={{ transform: `translate(${Math.round(hover.x + 14)}px, ${Math.round(hover.y - 12)}px)` }} role="tooltip">
          <p class="hover-title">{hub.name}</p>
          <p class="hover-meta">Concept hub · {plural(hub.count, 'entry', 'entries')}</p>
          <p class="hover-hint">Double-click to open</p>
        </div>
      )}

      {model && !empty && <Legend />}
    </section>
  );
}

function BrainSearch() {
  const [text, setText] = useState('');
  const timer = useRef(0);
  const run = (q: string) => {
    window.clearTimeout(timer.current);
    if (!q.trim()) {
      clearLight();
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const res = await api.get<{ hits: Hit[] }>(`search${qs({ q, limit: 500 })}`);
        light(
          res.hits.map((h) => h.id),
          `“${q.trim()}”`,
        );
      } catch (error) {
        toast(`Search failed: ${message(error)}`, { tone: 'error' });
      }
    }, 180);
  };
  return (
    <label class="brain-search">
      <Search size={15} aria-hidden="true" />
      <span class="sr-only">Light up matching points</span>
      <input
        type="search"
        placeholder="Light up…"
        value={text}
        onInput={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value;
          setText(v);
          run(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setText('');
            clearLight();
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

function ViewSettings({ onClose }: { onClose: () => void }) {
  const b = useApp((s) => s.config?.brain);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('input')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!b) return null;
  return (
    <div class="popover view-settings" role="dialog" aria-label="View settings" ref={ref}>
      <label class="range">
        <span>Point size</span>
        <input
          type="range"
          min="0.3"
          max="3"
          step="0.1"
          value={b.pointSize}
          onInput={(e) => void saveConfig({ brain: { pointSize: Number((e.currentTarget as HTMLInputElement).value) } }, true)}
        />
      </label>
      <label class="range">
        <span>Line density</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={b.lineDensity}
          onInput={(e) => void saveConfig({ brain: { lineDensity: Number((e.currentTarget as HTMLInputElement).value) } }, true)}
        />
      </label>
      <Switch label="Labels" checked={b.labels} onChange={(labels) => void saveConfig({ brain: { labels } })} />
      <Switch label="Slow turning" checked={b.turning} onChange={(turning) => void saveConfig({ brain: { turning } })} />
      <Button kind="quiet" small onClick={onClose}>
        Done
      </Button>
    </div>
  );
}

function ReadingBox({ layout, onClose }: { layout: Layout; onClose: () => void }) {
  return (
    <aside class="reading-box" aria-label="How to read this">
      <header>
        <strong>How to read this</strong>
        <Button icon={X} kind="quiet" small aria-label="Close" onClick={onClose} />
      </header>
      {layout === 'rings' ? (
        <dl>
          <dt>Place</dt>
          <dd>When. The centre is the first year; each ring outward is a year, and each slice a month.</dd>
          <dt>Colour</dt>
          <dd>The month, so the same season lines up from year to year.</dd>
          <dt>Size</dt>
          <dd>Notes are larger than messages, and grow with each link.</dd>
          <dt>Lines</dt>
          <dd>Threads join messages in one chat; arcs are links between notes.</dd>
        </dl>
      ) : (
        <dl>
          <dt>Place</dt>
          <dd>Each patch is one group from the legend, biggest first.</dd>
          <dt>Colour</dt>
          <dd>The same group as the patch.</dd>
          <dt>Size</dt>
          <dd>Notes are larger than messages, and grow with each link.</dd>
          <dt>Lines</dt>
          <dd>Threads join messages in one chat; arcs are links between notes.</dd>
        </dl>
      )}
    </aside>
  );
}

function Legend() {
  const grouping = useApp((s) => s.grouping);
  const layout = useApp((s) => s.layout);
  const isolate = useApp((s) => s.isolate);
  const compact = useApp((s) => s.compact);
  const model = useBrainModel()?.legend ?? null;
  const [more, setMore] = useState(false);
  if (!model) return null;
  const max = compact ? 4 : 7;
  const shown = more ? model : model.slice(0, max);
  const rest = model.length - max;
  const options = Object.entries(GROUPING_LABELS) as [ColourGrouping, string][];
  return (
    <div class={`legend${more ? ' open' : ''}`}>
      {layout === 'rings' ? (
        <span class="legend-by">By month</span>
      ) : (
        <Select label="Colour points" hideLabel value={grouping} options={options} onChange={setGrouping} />
      )}
      <ul class="legend-items" aria-label="Groups">
        {shown.map((g) => (
          <li key={g.label}>
            <button
              type="button"
              aria-pressed={isolate === g.label}
              class={isolate && isolate !== g.label ? 'dim' : ''}
              title={isolate === g.label ? 'Show every group' : `Show only ${g.label}`}
              onClick={() => setState({ isolate: isolate === g.label ? null : g.label })}
            >
              <span class="dot" style={{ background: g.color }} aria-hidden="true" />
              <span class="legend-label">{g.label}</span>
              <span class="legend-count">{fmtNum(g.count)}</span>
            </button>
          </li>
        ))}
        {rest > 0 && (
          <li>
            <button type="button" class="legend-more" aria-expanded={more} onClick={() => setMore(!more)}>
              {more ? 'Fewer' : `+${rest} more`}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
