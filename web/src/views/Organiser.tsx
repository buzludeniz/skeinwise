// What the organiser makes: Review, Runs, Folders and Hubs. Every change goes through the server's organiser API, and
// every correction is a run, so its toast and ⌘Z take it back.

import { useMemo, useState } from 'preact/hooks';
import { Check, FolderTree, GitCompareArrows, ListChecks, Merge, Network, RotateCcw, SkipForward, Sparkles, Workflow } from 'lucide-preact';
import { changed, engineName, loadRecord, message, openEntry, openNav, openPanel, organise, postRunUndo, toast, undoRun, wordNotice } from '../actions.ts';
import { api } from '../api.ts';
import { fmtDate, fmtNum, plural, runMade } from '../format.ts';
import { folderCounts } from '../nav.ts';
import { useApp } from '../store.ts';
import type { EntryDetail, Folder, ReviewItem, Run, SavedEntry } from '../types.ts';
import { Button, Empty, Select } from '../ui/common.tsx';

interface Resolution {
  item: ReviewItem;
  diff: string[];
  saved: boolean;
  /** The note's file when it is a Word document, which the update left as it was. */
  word: string | null;
}

/** Takes back a correction (a rename, a merge, a hub marked not useful): it is a run like any other. */
async function undoCorrection(runId: number): Promise<void> {
  await postRunUndo(runId);
  await loadRecord();
}

/** The button that starts the organiser, with the progress of a run that is going. */
export function OrganiseButton({ task = 'all', label }: { task?: Run['task'] | 'all'; label?: string }) {
  const job = useApp((s) => s.job);
  const ran = useApp((s) => s.organiser.runs.some((r) => r.task !== 'correction' && r.task !== 'ask'));
  const engine = useApp((s) => s.config?.ai.engine ?? 'none');
  const going = job !== null && !job.finished;
  return (
    <div class="organise-go">
      <Button
        icon={Sparkles}
        small
        kind="primary"
        disabled={going}
        onClick={() => void organise({ task, scope: ran ? 'new' : 'all' }).catch((error: unknown) => toast(message(error), { tone: 'error' }))}
      >
        {going ? 'Organising…' : (label ?? (ran ? 'Organise new entries' : 'Organise the record'))}
      </Button>
      <span class="soft small" aria-live="polite">
        {going ? (job.line ?? 'Starting…') : engine === 'none' ? 'No-AI: word statistics, no model' : `With the ${engine} model, as set in Settings`}
      </span>
    </div>
  );
}

function useTitle() {
  const brain = useApp((s) => s.brain);
  return useMemo(() => {
    const map = new Map<number, string>();
    for (const p of brain?.points ?? []) map.set(p[0], p[8]);
    return (id: number) => map.get(id) || 'Untitled';
  }, [brain]);
}

export function ReviewList() {
  const items = useApp((s) => s.organiser.review);
  const ready = useApp((s) => s.organiser.ready);
  const title = useTitle();
  if (!items.length)
    return (
      <Empty icon={ListChecks} title="Nothing to review">
        <p>
          {ready
            ? 'No note looks out of date right now.'
            : 'The organiser marks notes that newer entries may have overtaken. Run the organiser to fill this list.'}
        </p>
      </Empty>
    );
  return (
    <ul class="review-list">
      {items.map((item) => (
        <ReviewCard key={item.id} item={item} title={title(item.noteEntry)} />
      ))}
    </ul>
  );
}

function ReviewCard({ item, title }: { item: ReviewItem; title: string }) {
  const [diff, setDiff] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const answer = async (action: 'update' | 'holds' | 'skip', yes = false) => {
    setBusy(true);
    try {
      // The note as it is now, so Undo can put it back after an update.
      const before = action === 'update' && yes ? (await api.get<EntryDetail>(`entries/${item.noteEntry}`)).entry.body : null;
      const done = await api.post<Resolution>(`review/${item.id}`, { action, yes });
      if (!done.saved) {
        setDiff(done.diff);
        return;
      }
      await loadRecord();
      if (before !== null) {
        changed(`Updated “${title}”`, `Put “${title}” back`, async () => {
          wordNotice(await api.put<SavedEntry>(`entries/${item.noteEntry}`, { body: before }));
          await loadRecord();
        });
        if (done.word) toast(`${done.word} is a Word document, which Skeinwise doesn’t write, so it doesn’t have this update.`);
      } else toast(action === 'holds' ? `“${title}” still holds. Those entries won’t flag it again.` : `Skipped “${title}” until the next review run.`);
    } catch (error) {
      toast(message(error), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const status = { open: null, updated: 'Updated', holds: 'Still holds', skipped: 'Skipped' }[item.status];
  return (
    <li class="card review-card">
      <header>
        <button type="button" class="link strong" onClick={() => openEntry(item.noteEntry)}>
          {title}
        </button>
        {status && <span class="tag">{status}</span>}
      </header>
      <ul class="reasons">
        {item.reasons.map((r) => (
          <li key={r.entryId}>
            <p>{r.why}</p>
            <button type="button" class="quote" onClick={() => openEntry(r.entryId)}>
              “{r.quote}” <span class="soft">{fmtDate(r.date)}</span>
            </button>
          </li>
        ))}
      </ul>
      {diff && (
        <pre class="diff" aria-label="Proposed change">
          {diff.map((l, i) => (
            <span key={i} class={l.startsWith('+ ') ? 'diff-add' : l.startsWith('- ') ? 'diff-del' : 'diff-same'}>
              {l}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
      {item.status === 'open' && (
        <div class="row">
          {diff ? (
            <Button icon={Check} kind="primary" small disabled={busy} onClick={() => void answer('update', true)}>
              Make this change
            </Button>
          ) : (
            <Button icon={GitCompareArrows} small disabled={busy} onClick={() => void answer('update')}>
              Update
            </Button>
          )}
          <Button icon={Check} small kind="quiet" disabled={busy} onClick={() => void answer('holds')}>
            Still holds
          </Button>
          <Button icon={SkipForward} small kind="quiet" disabled={busy} onClick={() => void answer('skip')}>
            Skip
          </Button>
        </div>
      )}
    </li>
  );
}

const TASKS: Record<Run['task'], string> = {
  tag: 'Tagging',
  file: 'Filing',
  link: 'Linking',
  hub: 'Hubs',
  layer: 'Layers',
  review: 'Review',
  ask: 'Question',
  correction: 'Your correction',
  note: 'Agent note',
};

export function RunsList() {
  const runs = useApp((s) => s.organiser.runs);
  if (!runs.length)
    return (
      <Empty icon={Workflow} title="No runs yet">
        <p>Every organising pass is listed here with its engine, model, time and counts, and each can be undone.</p>
        <OrganiseButton />
      </Empty>
    );
  return (
    <div class="runs-wrap">
      <OrganiseButton />
      <ol class="run-list">
        {runs.map((r) => (
          <li key={r.id} class={`card run${r.status === 'undone' ? ' undone' : ''}`}>
            <p class="run-head">
              <strong>{TASKS[r.task]}</strong>
              {r.status !== 'done' && <span class="tag">{r.status}</span>}
              <span class="soft small">
                {engineName(r.engine, r.model)} · {fmtDate(r.startedAt)} {r.startedAt.slice(11, 16)}
              </span>
            </p>
            {r.task === 'correction' ? <p>{r.message ?? '—'}</p> : <p>{runMade(r.counts)}</p>}
            {r.task !== 'correction' && r.message && <p class="soft small">{r.message}</p>}
            {r.status === 'done' && r.task !== 'ask' && (
              <Button icon={RotateCcw} small kind="quiet" onClick={() => void undoRun(r).catch((error: unknown) => toast(message(error), { tone: 'error' }))}>
                Undo run
              </Button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function FolderCard({ folder, others }: { folder: Folder; others: Folder[] }) {
  const [into, setInto] = useState<string | null>(null);
  const merge = async () => {
    const target = others.find((f) => String(f.id) === into);
    if (!target) return;
    try {
      const done = await api.post<{ runId: number }>('folders/merge', { from: folder.id, into: target.id });
      setInto(null);
      await loadRecord();
      changed(`Merged “${folder.name}” into “${target.name}”. The old name stays as an alias.`, `Unmerge “${folder.name}”`, () => undoCorrection(done.runId));
    } catch (error) {
      toast(message(error), { tone: 'error' });
    }
  };
  return (
    <li class="card">
      <button type="button" class="link strong" onClick={() => openNav({ kind: 'folder', key: folder.name })}>
        {folder.name}
      </button>{' '}
      <span class="soft">{plural(folder.entryIds.length, 'entry', 'entries')}</span>
      {folder.aliases.length > 0 && <p class="soft small">Also called {folder.aliases.join(', ')}</p>}
      {into === null ? (
        <Button icon={Merge} small kind="quiet" disabled={!others.length} onClick={() => setInto(String(others[0]!.id))}>
          Merge into…
        </Button>
      ) : (
        <div class="row">
          <Select label={`Merge ${folder.name} into`} hideLabel value={into} options={others.map((f) => [String(f.id), f.name] as [string, string])} onChange={setInto} />
          <Button kind="primary" small onClick={() => void merge()}>
            Merge
          </Button>
          <Button kind="quiet" small onClick={() => setInto(null)}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  );
}

export function FoldersList() {
  const brain = useApp((s) => s.brain);
  const folders = useApp((s) => s.organiser.folders);
  const counts = useMemo(() => (brain ? folderCounts(brain) : []), [brain]);
  if (folders.length)
    return (
      <ul class="folder-list">
        {folders.map((f) => (
          <FolderCard key={f.id} folder={f} others={folders.filter((o) => o.id !== f.id)} />
        ))}
      </ul>
    );
  return (
    <div>
      <p class="soft pad-x">
        These are the folders your entries came from. The organiser’s file task files them into folders by what they say,
        and you can merge those here.
      </p>
      <div class="pad-x">
        <OrganiseButton task="file" label="File the record" />
      </div>
      <ul class="folder-list">
        {(brain?.folders ?? []).map((name, i) => (
          <li key={name}>
            <button type="button" class="row-button" onClick={() => openNav({ kind: 'folder', key: name })}>
              <FolderTree size={16} aria-hidden="true" />
              <span>{name}</span>
              <span class="soft">{fmtNum(counts[i] ?? 0)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HubsList() {
  const hubs = useApp((s) => s.organiser.hubs);
  if (!hubs.length)
    return (
      <Empty icon={Network} title="No hubs yet">
        <p>Run the organiser to make hubs: one per idea that keeps coming up, with your own dated words behind it.</p>
        <OrganiseButton task="hub" label="Make hubs" />
      </Empty>
    );
  return (
    <ul class="folder-list">
      {hubs.map((h) => (
        <li key={h.id}>
          <button type="button" class="row-button" onClick={() => openPanel({ kind: 'hub', id: h.id })}>
            <Network size={16} aria-hidden="true" />
            <span>{h.name}</span>
            <span class="soft">{fmtNum(h.entries)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
