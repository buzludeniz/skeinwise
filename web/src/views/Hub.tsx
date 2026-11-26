// A concept hub: the organiser's reading of a set of entries, every line citing your own dated words.

import { useEffect, useState } from 'preact/hooks';
import { Brain, Merge, PencilLine, RefreshCw, ThumbsDown } from 'lucide-preact';
import { changed, closePanel, engineName, go, light, loadRecord, message, openEntry, organise, postRunUndo, toast } from '../actions.ts';
import { api } from '../api.ts';
import { fmtDate, plural } from '../format.ts';
import { useApp } from '../store.ts';
import type { HubDetail, HubItem } from '../types.ts';
import { Button, Empty, SidePanel } from '../ui/common.tsx';

const SECTIONS: ['in_short' | 'what_you_found' | 'open_ends', string][] = [
  ['in_short', 'In short'],
  ['what_you_found', 'What you found'],
  ['open_ends', 'Open ends'],
];

function Item({ item }: { item: HubItem }) {
  return (
    <li>
      <p>{item.text}</p>
      <button type="button" class="quote" onClick={() => openEntry(item.entryId)}>
        Your words, {fmtDate(item.date)}
      </button>
    </li>
  );
}

/** A correction is a run, so taking it back is undoing that run. */
async function undoCorrection(runId: number): Promise<void> {
  await postRunUndo(runId);
  await loadRecord();
}

export function HubPanel({ id }: { id: number }) {
  const revision = useApp((s) => s.revision);
  const job = useApp((s) => s.job);
  const spokes = useApp((s) => s.brain?.hubs.find((h) => h.id === id)?.entries ?? null);
  const [detail, setDetail] = useState<HubDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [mergeNote, setMergeNote] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<HubDetail>(`hubs/${id}`).then(
      (d) => live && (setDetail(d), setMissing(false)),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [id, revision]);

  if (missing)
    return (
      <SidePanel title="Concept hub" label="Concept hub" onClose={closePanel}>
        <Empty title="This hub is gone">
          <p>It may have been marked not useful, refreshed into a new hub, or undone.</p>
        </Empty>
      </SidePanel>
    );
  if (!detail)
    return (
      <SidePanel title="Concept hub" label="Concept hub" onClose={closePanel}>
        <p class="soft pad">Reading…</p>
      </SidePanel>
    );

  const { hub, run } = detail;
  const rename = async () => {
    const name = naming?.trim() ?? '';
    if (!name || name === hub.name) {
      setNaming(null);
      return;
    }
    try {
      const done = await api.post<{ runId: number }>(`hubs/${hub.id}/rename`, { name });
      setNaming(null);
      await loadRecord();
      changed(`Renamed the hub to “${name}”.`, `Name the hub “${hub.name}” again`, () => undoCorrection(done.runId));
    } catch (error) {
      toast(message(error), { tone: 'error' });
    }
  };
  const notUseful = async () => {
    try {
      const done = await api.post<{ runId: number }>(`hubs/${hub.id}/delete`);
      closePanel();
      await loadRecord();
      changed(`Took away the hub “${hub.name}”.`, `Bring back the hub “${hub.name}”`, () => undoCorrection(done.runId));
    } catch (error) {
      toast(message(error), { tone: 'error' });
    }
  };
  const refresh = () => void organise({ task: 'hub', scope: 'all' }).catch((error: unknown) => toast(message(error), { tone: 'error' }));
  const going = job !== null && !job.finished;

  return (
    <SidePanel title={hub.name} label="Concept hub" onClose={closePanel}>
      <p class="eyebrow">Concept hub</p>
      <p class="band band-machine">
        The organiser’s reading of {plural(detail.total, 'entry', 'entries')} of yours, not your words. Written by{' '}
        {run ? engineName(run.engine, run.model) : 'the organiser'} in run {hub.runId}.
      </p>
      {naming !== null && (
        <form
          class="row"
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
        >
          <input class="grow" value={naming} maxLength={80} aria-label="New name for the hub" autofocus onInput={(e) => setNaming((e.currentTarget as HTMLInputElement).value)} />
          <Button kind="primary" small type="submit">
            Save
          </Button>
          <Button kind="quiet" small onClick={() => setNaming(null)}>
            Cancel
          </Button>
        </form>
      )}
      {SECTIONS.map(([key, label]) => (
        <section key={key} class="reader-section">
          <h3>{label}</h3>
          {hub.sections[key].length ? (
            <ul class="hub-items">
              {hub.sections[key].map((item, i) => (
                <Item key={i} item={item} />
              ))}
            </ul>
          ) : (
            <p class="soft">Nothing here yet.</p>
          )}
        </section>
      ))}
      {mergeNote && (
        <p class="soft small" role="status">
          Merging two hubs isn’t in the organiser yet. Rename one, or mark the weaker one not useful.
        </p>
      )}
      <div class="row wrap">
        <Button icon={PencilLine} small onClick={() => setNaming(hub.name)}>
          Rename
        </Button>
        <Button icon={Merge} small aria-expanded={mergeNote} onClick={() => setMergeNote(!mergeNote)}>
          Merge into…
        </Button>
        <Button icon={ThumbsDown} small kind="quiet" onClick={() => void notUseful()}>
          Not useful
        </Button>
        <Button icon={RefreshCw} small kind="quiet" disabled={going} onClick={refresh}>
          {going ? 'Refreshing…' : 'Refresh'}
        </Button>
        <Button
          icon={Brain}
          small
          kind="quiet"
          onClick={() => {
            light(spokes ?? detail.entries.map((e) => e.id), hub.name);
            go('brain');
          }}
        >
          Light its entries
        </Button>
      </div>
    </SidePanel>
  );
}
