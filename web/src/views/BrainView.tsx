// The Brain: the record as a glowing point cloud, with search, Fit, view settings, layouts and the legend. One click
// on a point or its label pins a card for it; double-click opens it.

import { useEffect, useRef, useState } from 'preact/hooks';
import { Focus, Info, Plus, Search, SlidersHorizontal, X } from 'lucide-preact';
import { clearLight, go, light, message, openEntry, openPanel, saveConfig, setGrouping, setLayout, toast } from '../actions.ts';
import { api, qs } from '../api.ts';
import { PartCard } from '../brain/PartCard.tsx';
import { indexOfPoint, KIND_NAMES, type Part, partAt } from '../brain/parts.ts';
import { useBrainModel, useBrainScene } from '../brain/useBrain.ts';
import '../brain/brain.css';
import { fmtDate, fmtNum, plural, speakerName } from '../format.ts';
import { type ColourGrouping, GROUPING_LABELS } from '../groups.ts';
import type { Layout } from '../layout.ts';
import { setState, useApp } from '../store.ts';
import type { Hit } from '../types.ts';
import { Button, Empty, Segmented, Select, Switch } from '../ui/common.tsx';

const LAYOUTS: [Layout, string][] = [
  ['brain', 'Brain'],
  ['rings', 'Activity'],
  ['clusters', 'Clusters'],
];

/** What the screen reader hears when a point is selected. */
function selectedText(part: Part): string {
  return part.kind === 'entry'
    ? `Selected: ${part.title}, ${part.type.toLowerCase()}, ${fmtDate(part.at)}.`
    : `Selected: ${part.name}, concept hub, ${plural(part.count, 'entry', 'entries')}.`;
}

export function BrainView() {
  const host = useRef<HTMLDivElement>(null);
  const { scene, model, ok, loadFailed, hover } = useBrainScene(host, 'full');
  const brain = useApp((s) => s.brain);
  const layout = useApp((s) => s.layout);
  const lit = useApp((s) => s.lit);
  const compact = useApp((s) => s.compact);
  const clip = useApp((s) => s.clip);
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(layout === 'rings');
  // The selected point, by its point id (an entry id, or a hub id negated), so it outlives a regroup or a reload.
  const [selected, setSelected] = useState<{ point: number; keyboard: boolean } | null>(null);
  const index = selected && model ? indexOfPoint(model, selected.point) : -1;
  const part = index >= 0 && model && brain ? partAt(model, brain, index) : null;

  useEffect(() => setHelp(layout === 'rings'), [layout]);

  // The scene is shared with the Timeline's strip, which has no selection: leaving the Brain clears it.
  useEffect(() => () => scene?.select(-1), [scene]);

  // After useBrainScene's effects (new data clears the scene's selection), so the selection comes back after a reload.
  useEffect(() => {
    if (!scene || !model) return;
    scene.select(index);
    if (selected && index < 0) setSelected(null);
  }, [scene, model, index]);

  useEffect(() => {
    if (!scene) return;
    scene.onSelect = (i, keyboard) => {
      const point = i >= 0 ? model?.input.points[i]?.id : undefined;
      setSelected(point === undefined ? null : { point, keyboard });
    };
    return () => {
      scene.onSelect = () => undefined;
    };
  }, [scene, model]);

  const focusInCard = () => !!(document.activeElement as HTMLElement | null)?.closest?.('.part-card');

  /** Closes the card. If focus was in it, focus goes back to the point's label, or to the brain. */
  const closeCard = () => {
    const back = focusInCard();
    setSelected(null);
    if (back) scene?.focusLabel(index);
  };

  /** A row in the card: select it when the brain draws it, otherwise open it. */
  const pick = (point: number) => {
    if (model && indexOfPoint(model, point) >= 0) setSelected({ point, keyboard: focusInCard() });
    else if (point < 0) openPanel({ kind: 'hub', id: -point });
    else openEntry(point);
  };

  // The keys read this render's state through a ref. An effect re-registers only after the next paint, so an Esc
  // pressed just after the card closed would otherwise still see the card and never put the lit points back.
  const keys = useRef({ part, lit, settings, closeCard, scene });
  keys.current = { part, lit, settings, closeCard, scene };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { part, lit, settings, closeCard, scene } = keys.current;
      const typing = (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]');
      if (e.key === 'Escape' && !document.querySelector('.side-panel, .modal-open')) {
        // The card closes first; the next Esc puts the lit points back.
        if (part && !typing && !settings) closeCard();
        else if (lit) clearLight();
      }
      if (!typing && (e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target as HTMLElement).closest('canvas')) scene?.fit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const empty = brain && brain.points.length === 0;
  // The scene's point i is the model's, which is a sample when the record is past the cap.
  const point = hover && brain && model ? model.data.points[hover.index] : null;
  const hub = hover && model && !point ? model.hubs.find((h) => h.index === hover.index) : null;

  return (
    <section class="view brain-view" aria-label="Brain">
      <div class="brain-host" ref={host} />
      {loadFailed ? (
        <div class="brain-fallback">
          <Empty title="The brain didn't load">
            {/* No reload button: the page keeps its token in memory only (api.ts), so a reload can't open the record. And
                not this tab: the address differs from this page's only in its #fragment, so the browser would just scroll. */}
            <p>
              Its drawing code couldn't be fetched, most often because Skeinwise was updated after this page opened. To load the new version,
              open a new tab at the address Skeinwise printed when it started.
            </p>
          </Empty>
        </div>
      ) : (
        !ok && (
          <div class="brain-fallback">
            <Empty title="This browser can't draw the brain">
              <p>It needs WebGL. Everything else works: try Threads or Stats.</p>
            </Empty>
          </div>
        )
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
          <Button icon={Focus} kind="quiet" title="Frame the whole cloud (F)" onClick={() => scene?.fit()}>
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
          <Button
            icon={Info}
            kind="quiet"
            small
            aria-expanded={help && !part}
            onClick={() => {
              // The card and this box share the corner: asking for the box puts the card away.
              if (part) {
                setSelected(null);
                setHelp(true);
              } else setHelp(!help);
            }}
          >
            How to read this
          </Button>
        )}
      </div>
      {help && layout !== 'brain' && !part && <ReadingBox layout={layout} onClose={() => setHelp(false)} />}
      {part && brain && !clip && <PartCard part={part} record={brain} onPick={pick} onClose={closeCard} takeFocus={selected?.keyboard ?? false} />}
      <p class="sr-only" role="status">
        {part ? selectedText(part) : ''}
      </p>

      {point && hover && !clip && (
        <div class="hover-card" style={{ transform: `translate(${Math.round(hover.x + 14)}px, ${Math.round(hover.y - 12)}px)` }} role="tooltip">
          <p class="hover-title">{point[8] || 'Untitled'}</p>
          <p class="hover-meta">
            {fmtDate(point[7])} · {brain!.sources.find((s) => s.id === point[3])?.label ?? 'Unknown source'}
          </p>
          <p class="hover-meta">
            {KIND_NAMES[point[1]]} · {speakerName(brain!.speakers[point[2]] ?? '')}
          </p>
          <p class="hover-hint">Click to pin · double-click to open</p>
        </div>
      )}
      {hub && hover && !clip && (
        <div class="hover-card" style={{ transform: `translate(${Math.round(hover.x + 14)}px, ${Math.round(hover.y - 12)}px)` }} role="tooltip">
          <p class="hover-title">{hub.name}</p>
          <p class="hover-meta">Concept hub · {plural(hub.count, 'entry', 'entries')}</p>
          <p class="hover-hint">Click to pin · double-click to open</p>
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
  const brain = useBrainModel();
  const model = brain?.legend ?? null;
  const [more, setMore] = useState(false);
  if (!brain || !model) return null;
  const sampled = brain.data.points.length < brain.total;
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
      {sampled && (
        <span class="legend-sample" title="The brain draws a sample spread over time so it stays quick. Search, Threads and the Timeline still cover every entry.">
          Showing a sample: {fmtNum(brain.data.points.length)} of {fmtNum(brain.total)}
        </span>
      )}
    </div>
  );
}
