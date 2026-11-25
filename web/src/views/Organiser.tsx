// What the organiser makes: Review, Runs, Folders and Hubs. Until the organiser is part of this build, each shows an
// honest empty state; the lists are ready for when it is.

import { useMemo, useState } from 'preact/hooks';
import { Check, FolderTree, GitCompareArrows, ListChecks, Network, RotateCcw, SkipForward, Workflow } from 'lucide-preact';
import { changed, loadRecord, message, openEntry, openNav, openPanel, toast } from '../actions.ts';
import { api } from '../api.ts';
import { type DiffLine, lineDiff } from '../diff.ts';
import { fmtDate, fmtNum, plural } from '../format.ts';
import { folderCounts } from '../nav.ts';
import { useApp } from '../store.ts';
import type { EntryDetail, ReviewItem, Run } from '../types.ts';
import { Button, Empty } from '../ui/common.tsx';

/** For organiser actions whose API isn't in this build yet. */
export function organiserPending(): void {
  toast('That needs the organiser, which isn’t part of this build yet.');
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
  const [diff, setDiff] = useState<{ lines: DiffLine[]; before: string } | null>(null);
  const showDiff = async () => {
    try {
      const d = await api.get<EntryDetail>(`entries/${item.noteEntry}`);
      setDiff({ lines: lineDiff(d.entry.body, item.proposed), before: d.entry.body });
    } catch (error) {
      toast(message(error), { tone: 'error' });
    }
  };
  const apply = async () => {
    if (!diff) return;
    try {
      await api.put(`entries/${item.noteEntry}`, { body: item.proposed });
      await loadRecord();
      setDiff(null);
      changed(`Updated “${title}”`, `Put “${title}” back`, async () => {
        await api.put(`entries/${item.noteEntry}`, { body: diff.before });
        await loadRecord();
      });
    } catch (error) {
      toast(`Not updated: ${message(error)}`, { tone: 'error' });
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
          {diff.lines.map((l, i) => (
            <span key={i} class={`diff-${l.op}`}>
              {l.op === 'add' ? '+ ' : l.op === 'del' ? '− ' : '  '}
              {l.text}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
      {item.status === 'open' && (
        <div class="row">
          {diff ? (
            <Button icon={Check} kind="primary" small onClick={() => void apply()}>
              Make this change
            </Button>
          ) : (
            <Button icon={GitCompareArrows} small onClick={() => void showDiff()}>
              Update
            </Button>
          )}
          <Button icon={Check} small kind="quiet" onClick={organiserPending}>
            Still holds
          </Button>
          <Button icon={SkipForward} small kind="quiet" onClick={organiserPending}>
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
};

export function RunsList() {
  const runs = useApp((s) => s.organiser.runs);
  if (!runs.length)
    return (
      <Empty icon={Workflow} title="No runs yet">
        <p>Every organising pass will be listed here with its engine, model, time and counts, and each can be undone.</p>
      </Empty>
    );
  return (
    <table class="runs">
      <thead>
        <tr>
          <th scope="col">Task</th>
          <th scope="col">Engine</th>
          <th scope="col">When</th>
          <th scope="col">Made</th>
          <th scope="col">
            <span class="sr-only">Undo</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} class={r.status === 'undone' ? 'undone' : ''}>
            <td>
              {TASKS[r.task]}
              {r.status !== 'done' && <span class="tag">{r.status}</span>}
            </td>
            <td>
              {r.engine === 'none' ? 'No AI' : r.engine === 'you' ? 'You' : r.engine}
              {r.model && <span class="soft"> · {r.model}</span>}
            </td>
            <td>{fmtDate(r.startedAt)}</td>
            <td>
              {Object.entries(r.counts)
                .map(([k, v]) => `${fmtNum(v)} ${k}`)
                .join(', ') || '—'}
            </td>
            <td>
              {r.status === 'done' && (
                <Button icon={RotateCcw} small kind="quiet" onClick={organiserPending}>
                  Undo run
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FoldersList() {
  const brain = useApp((s) => s.brain);
  const folders = useApp((s) => s.organiser.folders);
  const ready = useApp((s) => s.organiser.ready);
  const counts = useMemo(() => (brain ? folderCounts(brain) : []), [brain]);
  if (ready && folders.length)
    return (
      <ul class="folder-list">
        {folders.map((f) => (
          <li key={f.id} class="card">
            <strong>{f.name}</strong> <span class="soft">{plural(f.entryIds.length, 'entry', 'entries')}</span>
            {f.aliases.length > 0 && <p class="soft">Also called {f.aliases.join(', ')}</p>}
            <Button small kind="quiet" onClick={organiserPending}>
              Merge into…
            </Button>
          </li>
        ))}
      </ul>
    );
  return (
    <div>
      <p class="soft pad-x">
        These are the folders your entries came from. The organiser will file entries into folders of its own, which you
        can merge and rename here.
      </p>
      <ul class="folder-list">
        {(brain?.folders ?? []).map((name, i) => (
          <li key={name}>
            <button type="button" class="row-button" onClick={() => openNav({ kind: 'folder', key: String(i) })}>
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
      </Empty>
    );
  return (
    <ul class="folder-list">
      {hubs.map((h) => (
        <li key={h.id}>
          <button type="button" class="row-button" onClick={() => openPanel({ kind: 'hub', id: h.id })}>
            <Network size={16} aria-hidden="true" />
            <span>{h.name}</span>
            <span class="soft">{fmtNum(h.entries.length)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
