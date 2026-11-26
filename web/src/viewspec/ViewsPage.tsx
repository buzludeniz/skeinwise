// Views: charts and lists of the record. The built-in views, the ones you saved, and new ones the local model draws
// from a few words. A view is a spec, data only: its title and the record's values reach the page as text, and its
// chart is drawn by the Workbench's own Grid and Plot. When the model's view can't be used, the closest built-in
// stands in and the page says why. Under No-AI the built-in and saved views still show; drawing says it needs the
// local model.

import { useEffect, useState } from 'preact/hooks';
import { Save, Sparkles, X } from 'lucide-preact';
import { changed, message, openEntry, openThread, toast } from '../actions.ts';
import { api } from '../api.ts';
import { fmtDate, plural, speakerName } from '../format.ts';
import { useApp } from '../store.ts';
import { Button, Empty, Segmented } from '../ui/common.tsx';
import { Grid, Plot, valueLabel } from './primitives.ts';
import type { CellReply, Drawn, ListItem, SavedView, ViewDataReply, ViewForm, ViewsIndex, ViewSpec } from './types.ts';
import './views.css';

const FORMS: [ViewForm, string][] = [
  ['table', 'Table'],
  ['heatmap', 'Heatmap'],
  ['bars', 'Bars'],
  ['stacked', 'Stacked bars'],
  ['lines', 'Lines'],
  ['dots', 'Dots'],
];

/** The view on show, and where it came from. */
interface Shown {
  spec: ViewSpec;
  from: 'builtin' | 'saved' | 'drawn' | 'stand-in';
  /** The built-in or saved view's id. */
  id: string | null;
  /** Why a built-in stands in for what was asked. */
  why: string[];
  model: string | null;
  /** True once the form was picked by hand. */
  changedForm: boolean;
}

const builtinShown = (b: { id: string; spec: ViewSpec }): Shown => ({ spec: b.spec, from: 'builtin', id: b.id, why: [], model: null, changedForm: false });

function origin(s: Shown): string {
  const base =
    s.from === 'builtin' ? 'A built-in view' : s.from === 'saved' ? 'A saved view' : s.from === 'drawn' ? `Drawn by the local model${s.model ? ` (${s.model})` : ''}` : 'The closest built-in view';
  return s.changedForm ? `${base} · form picked by hand` : base;
}

function Describe({ ai, limit, onDrawn }: { ai: ViewsIndex['ai']; limit: number; onDrawn: (d: Drawn) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!ai.draws) {
    return (
      <p class="soft" role="note">
        {ai.note}
      </p>
    );
  }
  const draw = async () => {
    const request = text.trim();
    if (!request || busy) return;
    setBusy(true);
    try {
      onDrawn(await api.post<Drawn>('views/draw', { request }));
    } catch (e) {
      toast(message(e), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="views-describe"
      onSubmit={(e) => {
        e.preventDefault();
        void draw();
      }}
    >
      <label class="field">
        <span>Describe a view</span>
        <input value={text} maxLength={limit} placeholder="My notes about the garden, month by month" disabled={busy} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
      </label>
      <Button icon={Sparkles} kind="primary" type="submit" disabled={busy || !text.trim()}>
        {busy ? 'Drawing…' : 'Draw'}
      </Button>
    </form>
  );
}

function Entries({ items, total }: { items: ListItem[]; total: number }) {
  return (
    <ul class="item-list">
      {items.map((e) => (
        <li key={e.id}>
          <button type="button" class="item" onClick={() => (e.threadId ? openThread(e.threadId, e.id) : openEntry(e.id))}>
            <span class="item-title">{e.title || 'Untitled'}</span>
            <span class="item-meta">
              {fmtDate(e.createdAt)} · {speakerName(e.speaker)} · {e.source}
            </span>
          </button>
        </li>
      ))}
      {total > items.length && <li class="soft small pad">The first {items.length} of {total} are shown.</li>}
    </ul>
  );
}

function CellEntries({ spec, x, y, label, onClose }: { spec: ViewSpec; x: string; y: string | null; label: string; onClose: () => void }) {
  const [data, setData] = useState<CellReply | null>(null);
  useEffect(() => {
    let live = true;
    setData(null);
    api.post<CellReply>('views/data', { spec, cell: { x, y } }).then(
      (d) => live && setData(d),
      (e: unknown) => live && toast(message(e), { tone: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [JSON.stringify(spec), x, y]);
  return (
    <section class="card cell-entries" aria-label={`Entries: ${label}`}>
      <header class="row">
        <h3>{label}</h3>
        {data && <span class="soft">{plural(data.total, 'entry', 'entries')}</span>}
        <Button icon={X} small kind="quiet" aria-label="Close the list" onClick={onClose} />
      </header>
      {data ? <Entries items={data.entries} total={data.total} /> : <p class="soft">Gathering…</p>}
    </section>
  );
}

function ViewCard({ shown, onForm, onSave }: { shown: Shown; onForm: (f: ViewForm) => void; onSave: () => Promise<void> }) {
  const revision = useApp((s) => s.revision);
  const [data, setData] = useState<ViewDataReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cell, setCell] = useState<{ xi: number; yi: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const key = JSON.stringify(shown.spec);

  useEffect(() => {
    let live = true;
    setData(null);
    setCell(null);
    api.post<ViewDataReply>('views/data', { spec: shown.spec }).then(
      (d) => live && (setData(d), setError(null)),
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [key, revision]);

  const spec = shown.spec;
  const canSave = shown.from === 'drawn' || shown.changedForm;
  const reasons = [...shown.why, ...(data?.notes ?? [])];

  return (
    <section class="card views-card" aria-label={`View: ${spec.title}`}>
      <header>
        <h2>{spec.title}</h2>
        <span class="soft small">{origin(shown)}</span>
        {canSave && (
          <Button
            icon={Save}
            small
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              await onSave();
              setSaving(false);
            }}
          >
            Save view
          </Button>
        )}
      </header>
      {reasons.length > 0 && (
        <ul class="views-why warn-text small" aria-label="Why this view">
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {spec.show === 'chart' && <Segmented label="Form" options={FORMS} value={spec.form} onChange={onForm} />}
      {error ? (
        <Empty title="Couldn't show this view">{error}</Empty>
      ) : !data ? (
        <p class="soft pad">Counting…</p>
      ) : data.total === 0 ? (
        <Empty title="No entries match">
          <p>Nothing in your record fits this view yet.</p>
        </Empty>
      ) : data.show === 'list' ? (
        <>
          <p class="soft small">{plural(data.total, 'entry', 'entries')}</p>
          <Entries items={data.items} total={data.total} />
        </>
      ) : spec.show === 'chart' ? (
        <>
          <p class="soft small">
            {plural(data.total, 'entry', 'entries')}. Click a {spec.form === 'table' || spec.form === 'heatmap' ? 'cell' : 'mark'} to list its entries.
          </p>
          {spec.form === 'table' || spec.form === 'heatmap' ? (
            <Grid t={data.table} heat={spec.form === 'heatmap'} onCell={setCell} />
          ) : (
            <Plot t={data.table} form={spec.form} onCell={setCell} />
          )}
          {cell && data.table.xs[cell.xi] !== undefined && (
            <CellEntries
              spec={spec}
              x={data.table.xs[cell.xi]!}
              y={data.single ? null : (data.table.ys[cell.yi] ?? null)}
              label={data.single ? valueLabel(spec.x, data.table.xs[cell.xi]!) : `${valueLabel(data.table.y, data.table.ys[cell.yi] ?? '')} · ${valueLabel(spec.x, data.table.xs[cell.xi]!)}`}
              onClose={() => setCell(null)}
            />
          )}
        </>
      ) : null}
    </section>
  );
}

export function ViewsPage() {
  const revision = useApp((s) => s.revision);
  const [index, setIndex] = useState<ViewsIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [reload, setReload] = useState(0);
  const again = () => setReload((n) => n + 1);

  useEffect(() => {
    let live = true;
    api.get<ViewsIndex>('views').then(
      (d) => {
        if (!live) return;
        setIndex(d);
        setError(null);
        setShown((s) => s ?? (d.builtins[0] ? builtinShown(d.builtins[0]) : null));
      },
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [revision, reload]);

  const drawn = (d: Drawn) => {
    setShown({ spec: d.spec, from: d.drawn ? 'drawn' : 'stand-in', id: d.builtin, why: d.why, model: d.model, changedForm: false });
    if (!d.drawn) toast('The closest built-in view is shown instead. The reasons are on the view.', { tone: 'error' });
  };

  const save = async () => {
    if (!shown) return;
    try {
      const saved = await api.post<SavedView>('views', { spec: shown.spec });
      toast(`Saved the view “${saved.spec.title}”.`, { tone: 'ok' });
      setShown({ spec: saved.spec, from: 'saved', id: saved.id, why: [], model: null, changedForm: false });
      again();
    } catch (e) {
      toast(message(e), { tone: 'error' });
    }
  };

  const remove = async (v: SavedView) => {
    try {
      await api.post(`views/${encodeURIComponent(v.id)}/delete`);
    } catch (e) {
      toast(message(e), { tone: 'error' });
      return;
    }
    if (shown?.from === 'saved' && shown.id === v.id && index?.builtins[0]) setShown(builtinShown(index.builtins[0]));
    again();
    changed(`Removed the view “${v.spec.title}”.`, `Bring back the view “${v.spec.title}”`, async () => {
      await api.post('views', { spec: v.spec });
      again();
    });
  };

  if (error)
    return (
      <section class="view workbench views-page" aria-label="Views">
        <Empty title="Couldn't load the views">{error}</Empty>
      </section>
    );
  if (!index)
    return (
      <section class="view workbench views-page" aria-label="Views" aria-busy="true">
        <p class="soft pad">Loading…</p>
      </section>
    );

  return (
    <section class="view workbench views-page" aria-label="Views">
      <header class="view-head">
        <h1>Views</h1>
        <p class="soft">Charts and lists of your record. Pick one, or describe the one you want.</p>
      </header>
      <Describe ai={index.ai} limit={index.limits.request} onDrawn={drawn} />
      <div class="views-shelf">
        <h2 id="views-builtin">Built in</h2>
        <ul class="saved-views" aria-labelledby="views-builtin">
          {index.builtins.map((b) => (
            <li key={b.id}>
              <button type="button" class="chip" aria-pressed={shown?.from === 'builtin' && shown.id === b.id} onClick={() => setShown(builtinShown(b))}>
                {b.spec.title}
              </button>
            </li>
          ))}
        </ul>
        <h2 id="views-saved">Saved</h2>
        {index.saved.length === 0 && index.broken.length === 0 && !index.problem ? (
          <p class="soft small">None yet. Draw a view, or pick a form for a built-in one, and save it.</p>
        ) : (
          <ul class="saved-views" aria-labelledby="views-saved">
            {index.saved.map((v) => (
              <li key={v.id} class="chip-pair">
                <button
                  type="button"
                  class="chip"
                  aria-pressed={shown?.from === 'saved' && shown.id === v.id}
                  onClick={() => setShown({ spec: v.spec, from: 'saved', id: v.id, why: [], model: null, changedForm: false })}
                >
                  {v.spec.title}
                </button>
                <button type="button" class="chip chip-x" aria-label={`Remove ${v.spec.title}`} onClick={() => void remove(v)}>
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {index.problem && <p class="warn-text small">{index.problem}</p>}
        {index.broken.length > 0 && (
          <ul class="views-why warn-text small" aria-label="Saved views that couldn't be read">
            {index.broken.map((b) => (
              <li key={b.id}>
                {b.id}.json: {b.reasons.join(' ')}
              </li>
            ))}
          </ul>
        )}
      </div>
      {shown && (
        <ViewCard
          shown={shown}
          onForm={(form) => shown.spec.show === 'chart' && setShown({ ...shown, spec: { ...shown.spec, form }, changedForm: true })}
          onSave={save}
        />
      )}
    </section>
  );
}
