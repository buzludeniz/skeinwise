// The reader: one entry with its layers, neighbours and history, or a whole thread.

import { useEffect, useRef, useState } from 'preact/hooks';
import { BotMessageSquare, Copy, History, Link2, PencilLine, UserX } from 'lucide-preact';
import { changed, loadRecord, message, openEditor, openEntry, openThread, toast } from '../actions.ts';
import { api } from '../api.ts';
import { fmtDate, plural, speakerName } from '../format.ts';
import { renderMarkdown } from '../markdown.ts';
import { useApp } from '../store.ts';
import type { Brief, Entry, EntryDetail, LayerName, Thread } from '../types.ts';
import { Button, Empty, SidePanel } from '../ui/common.tsx';

type ReaderTarget = { kind: 'entry'; id: number } | { kind: 'thread'; id: number; focus?: number };
type Detail = EntryDetail & { ownFile: boolean };

const LAYERS: ['original' | LayerName, string][] = [
  ['original', 'Original'],
  ['cleaned', 'Cleaned'],
  ['expanded', 'Expanded'],
  ['digest', 'Digest'],
  ['ideas', 'Ideas'],
];

const KIND_LABEL: Record<string, string> = { message: 'Message', note: 'Note', file: 'File' };

/** Opens [[Note]] links inside rendered Markdown. */
function useWikiLinks(ref: { current: HTMLElement | null }) {
  const brain = useApp((s) => s.brain);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button.wikilink');
      if (!btn) return;
      const name = (btn.dataset.note ?? '').toLowerCase();
      const hit = brain?.points.find((p) => p[1] === 1 && p[8].trim().toLowerCase() === name);
      if (hit) openEntry(hit[0]);
      else toast(`No note called “${btn.dataset.note}” yet`);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [brain]);
}

function Body({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useWikiLinks(ref);
  return <div class="prose body" ref={ref} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

function BriefLink({ b, label }: { b: Brief; label?: string }) {
  return (
    <button type="button" class="brief" onClick={() => openEntry(b.id)}>
      {label && <span class="brief-tag">{label}</span>}
      <span class="brief-title">{b.title || 'Untitled'}</span>
      <span class="brief-meta">
        {fmtDate(b.createdAt)} · {b.sourceLabel} · {speakerName(b.speaker)}
      </span>
    </button>
  );
}

function copyLink(id: number) {
  const url = `${location.origin}/?entry=${id}`;
  navigator.clipboard.writeText(url).then(
    () => toast('Link copied. It opens this entry in Skeinwise on this computer.'),
    () => toast(`Copy this link: ${url}`),
  );
}

function EntryReader({ id }: { id: number }) {
  const revision = useApp((s) => s.revision);
  const organiser = useApp((s) => s.organiser.ready);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layer, setLayer] = useState<(typeof LAYERS)[number][0]>('original');
  const [showVersion, setShowVersion] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api.get<Detail>(`entries/${id}`).then(
      (d) => live && setDetail(d),
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [id, revision]);

  useEffect(() => {
    setLayer('original');
    setShowVersion(null);
  }, [id]);

  if (error) return <Empty title="Couldn't open this entry">{error}</Empty>;
  if (!detail || detail.entry.id !== id) return <p class="soft pad">Opening…</p>;
  const { entry, history, thread, before, after, similar, editedByAgent } = detail;
  const shown = showVersion === null ? entry.body : (history.find((v) => v.version === showVersion)?.body ?? entry.body);

  return (
    <article class="reader" aria-label={entry.title ?? 'Entry'}>
      <header class="reader-head">
        <p class="eyebrow">
          {KIND_LABEL[entry.kind] ?? entry.kind} · {speakerName(entry.speaker)}
        </p>
        <h2>{entry.title || (thread ? thread.title : 'Untitled')}</h2>
        <p class="soft">
          {fmtDate(entry.createdAt)} · {entry.sourceLabel}
          {entry.version > 1 && ` · version ${entry.version}`}
        </p>
      </header>
      {editedByAgent && (
        <p class="band band-agent">
          <BotMessageSquare size={15} aria-hidden="true" /> Edited by an agent ({editedByAgent}). See History for what changed.
        </p>
      )}
      <div class="reader-actions">
        <Button icon={PencilLine} small onClick={() => openEditor(entry.id, entry.title ?? '')}>
          Edit
        </Button>
        {thread && (
          <Button icon={Link2} small onClick={() => openThread(thread.id, entry.id)}>
            Whole thread
          </Button>
        )}
        <Button icon={Copy} small kind="quiet" onClick={() => copyLink(entry.id)}>
          Copy link
        </Button>
      </div>

      <div class="tabs" role="tablist" aria-label="Layers">
        {LAYERS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={layer === key} class={layer === key ? 'on' : ''} onClick={() => setLayer(key)}>
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" class="layer">
        {layer === 'original' ? (
          <>
            {showVersion !== null && (
              <p class="band">
                Showing version {showVersion}.{' '}
                <button type="button" class="link" onClick={() => setShowVersion(null)}>
                  Back to the latest
                </button>
              </p>
            )}
            <Body text={shown} />
          </>
        ) : (
          <>
            <p class="band band-machine">Not your words: this tab is written by the organiser, which names its engine, model and run here.</p>
            <Empty title={`No ${layer} layer yet`}>
              <p>{organiser ? 'The organiser hasn’t written this layer for this entry yet.' : 'Run the organiser to make this layer.'}</p>
            </Empty>
          </>
        )}
      </div>

      <section class="reader-section" aria-label="Neighbours">
        <h3>Neighbours</h3>
        {before && <BriefLink b={before} label="Before" />}
        {after && <BriefLink b={after} label="After" />}
        {similar.length > 0 && <p class="eyebrow">Most similar</p>}
        {similar.map((b) => (
          <BriefLink key={b.id} b={b} />
        ))}
        {!before && !after && !similar.length && <p class="soft">Nothing close by.</p>}
      </section>

      <section class="reader-section" aria-label="History">
        <h3>
          <History size={15} aria-hidden="true" /> History
        </h3>
        <ol class="history">
          {[...history].reverse().map((v) => (
            <li key={v.version}>
              <button
                type="button"
                class={showVersion === v.version || (showVersion === null && v.version === entry.version) ? 'on' : ''}
                onClick={() => {
                  setLayer('original');
                  setShowVersion(v.version === entry.version ? null : v.version);
                }}
              >
                <span>Version {v.version}</span>
                <span class="soft">
                  {v.editor === 'import' ? 'Imported' : v.editor === 'you' ? 'You' : v.editor} · {fmtDate(v.editedAt)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

function ThreadReader({ id, focus }: { id: number; focus?: number }) {
  const revision = useApp((s) => s.revision);
  const [data, setData] = useState<{ thread: Thread; entries: Entry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let live = true;
    api.get<{ thread: Thread; entries: Entry[] }>(`threads/${id}`).then(
      (d) => live && setData(d),
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [id, revision]);

  useEffect(() => {
    if (!data || focus === undefined) return;
    list.current?.querySelector(`[data-id="${focus}"]`)?.scrollIntoView({ block: 'center' });
  }, [data, focus]);

  if (error) return <Empty title="Couldn't open this thread">{error}</Empty>;
  if (!data || data.thread.id !== id) return <p class="soft pad">Opening…</p>;
  const { thread, entries } = data;

  const setNotMine = async (notMine: boolean) => {
    try {
      await api.post(`threads/${id}/not-mine`, { notMine });
      setData({ thread: { ...thread, notMine }, entries });
      await loadRecord();
      changed(notMine ? 'Left out as not yours' : 'Back in the record', notMine ? 'Mark the thread as yours' : 'Mark the thread as not mine', async () => {
        await api.post(`threads/${id}/not-mine`, { notMine: !notMine });
        await loadRecord();
      });
    } catch (error) {
      toast(`Not changed: ${message(error)}`, { tone: 'error' });
    }
  };

  return (
    <article class="reader thread" aria-label={thread.title}>
      <header class="reader-head">
        <p class="eyebrow">Thread · {plural(thread.entries, 'entry', 'entries')}</p>
        <h2>{thread.title || 'Untitled thread'}</h2>
        <p class="soft">
          Started {fmtDate(thread.startedAt)} · {entries[0]?.sourceLabel ?? ''}
        </p>
      </header>
      {thread.notMine && <p class="band">Marked not mine: this thread is left out of the brain, search, You and Numbers.</p>}
      <div class="reader-actions">
        <Button icon={UserX} small aria-pressed={thread.notMine} onClick={() => void setNotMine(!thread.notMine)}>
          {thread.notMine ? 'Mine after all' : 'Not mine'}
        </Button>
        {focus !== undefined && (
          <Button icon={Copy} small kind="quiet" onClick={() => copyLink(focus)}>
            Copy link
          </Button>
        )}
      </div>
      <ol class="turns" ref={list}>
        {entries.map((e) => (
          <li key={e.id} data-id={e.id} class={`turn turn-${e.speaker === 'assistant' ? 'assistant' : 'you'}${e.id === focus ? ' focus' : ''}`}>
            <p class="turn-head">
              <strong>{speakerName(e.speaker)}</strong>
              <span class="soft">{fmtDate(e.createdAt)}</span>
              <button type="button" class="link" onClick={() => openEntry(e.id)}>
                Open
              </button>
            </p>
            <Body text={e.body} />
          </li>
        ))}
      </ol>
    </article>
  );
}

export function Reader({ target }: { target: ReaderTarget }) {
  return target.kind === 'entry' ? <EntryReader id={target.id} /> : <ThreadReader id={target.id} focus={target.focus} />;
}

export function ReaderPanel({ panel, onClose }: { panel: ReaderTarget; onClose: () => void }) {
  return (
    <SidePanel title={panel.kind === 'entry' ? 'Entry' : 'Thread'} label="Reader" onClose={onClose} wide>
      <Reader target={panel} />
    </SidePanel>
  );
}
