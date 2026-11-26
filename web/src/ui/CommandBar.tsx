// The command bar: one field for search, questions and commands. ⌘K opens it.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';
import { ArrowRight, Brain, CircleHelp, FilePlus2, FileText, Lock, MessageSquareText, NotebookPen, Palette, Search, Sparkles, Undo2 } from 'lucide-preact';
import {
  canUndo,
  closeCommand,
  engineName,
  go,
  light,
  loadRecord,
  lock,
  message,
  openEditor,
  openEntry,
  openNav,
  openThread,
  organise,
  setLayout,
  setTheme,
  toast,
  undo,
} from '../actions.ts';
import { api, qs } from '../api.ts';
import { fmtDate, plural, speakerName } from '../format.ts';
import { snippetHtml } from '../markdown.ts';
import { setState, useApp } from '../store.ts';
import { THEMES } from '../themes.ts';
import type { AskHit, AskResult, Hit } from '../types.ts';
import { Kbd, MOD, useFocusTrap } from './common.tsx';

interface Row {
  key: string;
  icon: LucideIcon;
  title: string;
  meta?: string;
  snippet?: string;
  run: () => void | Promise<void>;
}

/** Places `go to …` reaches, by the words people type. */
const PLACES: [string[], string, () => void][] = [
  [['brain', 'home'], 'Brain', () => go('brain')],
  [['threads', 'notes'], 'Threads', () => go('threads')],
  [['stats', 'figures'], 'Stats', () => go('stats')],
  [['timeline'], 'Timeline', () => go('timeline')],
  [['profile', 'me'], 'Profile', () => go('profile')],
  [['workbench', 'table'], 'Workbench', () => go('workbench')],
  [['activity'], 'Activity', () => setState({ view: 'workbench', workbenchTab: 'activity', editor: null })],
  [['assistant', 'brief', 'tasks', 'loops'], 'Assistant', () => go('assistant')],
  [['guide', 'help'], 'Guide', () => go('guide')],
  [['add', 'import'], 'Add', () => go('add')],
  [['review'], 'Review', () => openNav({ kind: 'review' })],
  [['runs'], 'Runs', () => openNav({ kind: 'runs' })],
  [['hubs'], 'Hubs', () => openNav({ kind: 'hubs' })],
  [['folders'], 'Folders', () => openNav({ kind: 'folders' })],
  [['inbox'], 'Inbox', () => openNav({ kind: 'inbox' })],
  [['activity layout', 'rings', 'years'], 'Activity layout', () => setLayout('rings')],
  [['clusters'], 'Clusters', () => setLayout('clusters')],
  [['settings', 'preferences'], 'Settings', () => setState({ settingsOpen: true })],
];

const HINTS: [string, string][] = [
  ['note …', 'Add a line to today’s note'],
  ['new note …', 'Start a note with this title'],
  ['open …', 'Open the best match'],
  ['go to …', 'Brain, Timeline, Workbench, Review, Settings…'],
  ['theme …', THEMES.map((t) => t.name).join(', ')],
  ['when did I first mention …?', 'Ask, and see your own entries'],
  ['organise', 'Run the organiser: tags, folders, links, hubs'],
  ['undo', 'Take back the last change'],
  ['lock', 'Close the record until you unlock'],
];

function openHit(h: { id: number; threadId?: number | null }) {
  if (h.threadId) openThread(h.threadId, h.id);
  else openEntry(h.id);
}

const KIND_HEAD: Record<AskResult['kind'], string> = {
  first: 'Your earliest words on it, oldest first.',
  decided: 'Where you settled it, in your own words, oldest first.',
  changed: 'Where you started, then each change of course.',
  any: 'The entries that match best.',
};

const WHY: Record<NonNullable<AskHit['why']>, string> = {
  'first mention': 'First mention',
  decision: 'Decision',
  change: 'Change',
};

function Answer({ view, onBack }: { view: AskResult; onBack: () => void }) {
  const first = view.hits[0];
  const cited = new Set(view.cites);
  return (
    <div class="answer" aria-live="polite">
      <p class="eyebrow">Answer from your record</p>
      <h2>{view.question}</h2>
      {view.answer && (
        <div class="model-answer">
          <p>{view.answer}</p>
          <p class="band small">
            The organiser’s reading of these entries, not your words · {engineName(view.engine, view.model)}
            {view.runId !== null && <> · run {view.runId}</>}
          </p>
        </div>
      )}
      {view.message && <p class="soft">{view.message}</p>}
      {view.hits.length > 0 && (
        <>
          <p>
            {view.kind === 'first' && first ? (
              <>
                You first wrote about “{view.topic}” on <strong>{fmtDate(first.date)}</strong>.{' '}
              </>
            ) : null}
            {plural(view.hits.length, 'entry', 'entries')}. {KIND_HEAD[view.kind]}
          </p>
          {!view.answer && <p class="soft small">Found by search and dates. No model wrote this. They are lit in the brain.</p>}
          <ul class="hits">
            {view.hits.slice(0, 12).map((h) => (
              <li key={h.entryId}>
                <button
                  type="button"
                  class="hit"
                  onClick={() => {
                    closeCommand();
                    openEntry(h.entryId);
                  }}
                >
                  <span class="hit-title">
                    {h.where || 'Untitled'}
                    {h.why && <span class="tag">{WHY[h.why]}</span>}
                    {cited.has(h.entryId) && <span class="tag">Cited</span>}
                  </span>
                  <span class="hit-meta">
                    {fmtDate(h.date)} · {speakerName(h.speaker)}
                  </span>
                  <span class="hit-snippet">“{h.quote}”</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div class="row">
        <button type="button" class="btn btn-quiet btn-small" onClick={onBack}>
          Back to the search
        </button>
        {view.hits.length > 0 && (
          <button
            type="button"
            class="btn btn-primary btn-small"
            onClick={() => {
              closeCommand();
              go('brain');
            }}
          >
            <Brain size={14} aria-hidden="true" />
            <span>See them in the brain</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function CommandBar() {
  const open = useApp((s) => s.command.open);
  const initial = useApp((s) => s.command.text);
  if (!open) return null;
  return <Bar initial={initial} />;
}

function Bar({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  const [result, setResult] = useState<{ query: string; question: boolean; hits: Hit[] } | null>(null);
  const [at, setAt] = useState(0);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const runs = useApp((s) => s.organiser.runs);
  const engine = useApp((s) => s.config?.ai.engine ?? 'none');
  const [busy, setBusy] = useState(false);
  const box = useFocusTrap(true);
  const list = useRef<HTMLUListElement>(null);
  const q = text.trim();

  useEffect(() => {
    setAt(0);
    const words = q.replace(/^(open|go to|theme)\s+/i, '');
    if (!words || /^(note|new note|go to|theme)\b/i.test(q) || q.length < 2) {
      setResult(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api.get<{ query: string; question: boolean; hits: Hit[] }>(`search${qs({ q: words, limit: 8 })}`).then(
        (r) => live && setResult(r),
        () => live && setResult(null),
      );
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const ask = async () => {
    setBusy(true);
    try {
      const view = await api.get<AskResult>(`ask${qs({ q })}`);
      setAnswer(view);
      if (view.hits.length) light(view.hits.map((h) => h.entryId), q);
    } catch (error) {
      toast(message(error), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const lower = q.toLowerCase();
    const verb = ['new note', 'note', 'go to', 'theme'].find((v) => lower === v || lower.startsWith(`${v} `)) ?? '';
    const rest = q.slice(verb.length).trim();
    if (verb === 'note' && rest) {
      out.push({
        key: 'note',
        icon: NotebookPen,
        title: `Add to today’s note: “${rest}”`,
        run: async () => {
          await api.post('daily', { text: rest });
          await loadRecord();
          toast('Added to today’s note.', { tone: 'ok' });
        },
      });
    }
    if (verb === 'new note') {
      out.push({ key: 'new', icon: FilePlus2, title: rest ? `New note: “${rest}”` : 'New note', run: () => openEditor(null, rest) });
    }
    if (verb === 'go to') {
      const want = rest.toLowerCase();
      for (const [words, label, run] of PLACES) {
        if (!want || words.some((w) => w.startsWith(want) || want.startsWith(w))) out.push({ key: `go-${label}`, icon: ArrowRight, title: `Go to ${label}`, run });
      }
    }
    if (verb === 'theme') {
      const want = rest.toLowerCase();
      for (const t of THEMES) {
        if (!want || t.name.toLowerCase().startsWith(want)) out.push({ key: `theme-${t.key}`, icon: Palette, title: `Theme: ${t.name}`, meta: t.light ? 'Light' : 'Dark', run: () => setTheme(t.key) });
      }
    }
    if (/^undo$/i.test(q)) out.push({ key: 'undo', icon: Undo2, title: canUndo() ? `Undo: ${canUndo()}` : 'Undo', run: () => undo() });
    if (/^lock$/i.test(q)) out.push({ key: 'lock', icon: Lock, title: 'Lock Skeinwise', run: () => lock() });
    const organiseVerb = /^organi[sz]e(?:\s+(.*))?$/i.exec(q);
    if (organiseVerb) {
      const task = (organiseVerb[1] ?? '').trim().toLowerCase();
      const tasks = ['tag', 'file', 'link', 'hub', 'layer', 'review'] as const;
      const one = tasks.find((t) => t === task || `${t}s` === task);
      const by = engine === 'none' ? 'No-AI' : `with the ${engine} model`;
      const ran = runs.some((r) => r.task !== 'correction' && r.task !== 'ask');
      const what = one ? `the ${one} task` : 'every task';
      if (ran) out.push({ key: 'organise-new', icon: Sparkles, title: `Organise new entries: ${what}`, meta: `Only what came in since the last run · ${by}`, run: () => organise({ task: one ?? 'all', scope: 'new' }) });
      out.push({
        key: 'organise',
        icon: Sparkles,
        title: ran ? `Organise everything again: ${what}` : `Organise the record: ${what}`,
        meta: ran ? `Replaces the earlier runs’ output · ${by}` : by,
        run: () => organise({ task: one ?? 'all', scope: 'all' }),
      });
    }
    if (result && result.query === q.replace(/^(open)\s+/i, '')) {
      if (result.question) out.unshift({ key: 'ask', icon: CircleHelp, title: `Ask: ${q}`, meta: 'Answers with your own entries', run: ask });
      for (const h of result.hits) {
        out.push({
          key: `hit-${h.id}`,
          icon: h.kind === 'message' ? MessageSquareText : FileText,
          title: h.title || h.threadTitle || 'Untitled',
          meta: `${fmtDate(h.createdAt)} · ${speakerName(h.speaker)} · ${h.sourceLabel}`,
          snippet: h.snippet,
          run: () => openHit(h),
        });
      }
      if (result.hits.length > 1) {
        out.push({
          key: 'light',
          icon: Search,
          title: `Light the matches for “${result.query}” in the brain`,
          run: async () => {
            const all = await api.get<{ hits: Hit[] }>(`search${qs({ q: result.query, limit: 500 })}`);
            light(all.hits.map((h) => h.id), result.query);
            go('brain');
          },
        });
      }
    }
    return out;
  }, [q, result, runs, engine]);

  const run = async (row: Row | undefined) => {
    if (!row) return;
    const keepOpen = row.key === 'ask';
    try {
      if (!keepOpen) closeCommand();
      await row.run();
    } catch (error) {
      toast(message(error), { tone: 'error' });
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (answer) setAnswer(null);
      else closeCommand();
      return;
    }
    if (answer) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const next = (at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      setAt(next);
      list.current?.children[next]?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (rows.length) void run(rows[at]);
      else if (q && result?.question) void ask();
    }
  };

  return (
    <div class="overlay modal-open" onPointerDown={(e) => e.target === e.currentTarget && closeCommand()}>
      <div class="command" role="dialog" aria-modal="true" aria-label="Command bar" ref={box} onKeyDown={onKey}>
        <label class="command-field">
          <Search size={18} aria-hidden="true" />
          <span class="sr-only">Search, ask or type a command</span>
          <input
            autofocus
            value={text}
            placeholder="Search, ask a question, or type a command"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="command-rows"
            aria-activedescendant={rows[at] ? `cmd-${rows[at]!.key}` : undefined}
            onInput={(e) => {
              setText((e.currentTarget as HTMLInputElement).value);
              setAnswer(null);
            }}
          />
          {busy && <span class="soft small">Looking…</span>}
          <Kbd>Esc</Kbd>
        </label>
        {answer ? (
          <Answer view={answer} onBack={() => setAnswer(null)} />
        ) : rows.length ? (
          <ul class="command-rows" id="command-rows" role="listbox" ref={list} aria-label="Results">
            {rows.map((r, i) => (
              <li key={r.key} id={`cmd-${r.key}`} role="option" aria-selected={i === at} class={i === at ? 'on' : ''} onPointerMove={() => setAt(i)} onClick={() => void run(r)}>
                <r.icon size={16} aria-hidden="true" />
                <span class="row-text">
                  <span class="row-title">{r.title}</span>
                  {r.meta && <span class="row-meta">{r.meta}</span>}
                  {r.snippet && <span class="row-snippet" dangerouslySetInnerHTML={{ __html: snippetHtml(r.snippet) }} />}
                </span>
              </li>
            ))}
          </ul>
        ) : q.length >= 2 && result && !result.hits.length ? (
          <p class="soft pad">Nothing in the record matches “{q}”.</p>
        ) : (
          <ul class="command-hints" aria-label="What you can type">
            {HINTS.map(([cmd, what]) => (
              <li key={cmd}>
                <button type="button" class="hint" onClick={() => setText(cmd.replace(/…\??$/, ''))}>
                  <code>{cmd}</code>
                  <span class="soft">{what}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <footer class="command-foot soft small">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move, <Kbd>↵</Kbd> to open
          </span>
          <span>
            <Kbd>{MOD}K</Kbd> opens this anywhere
          </span>
        </footer>
      </div>
    </div>
  );
}
