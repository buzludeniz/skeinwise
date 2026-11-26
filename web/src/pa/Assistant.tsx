// The assistant: the brief, your open loops, your tasks and reminders, and a question to your record. Every part works
// with no model; when the settings name one, it writes the brief's lines and reads loops more closely. Quotes and cite
// chips open the entry they came from.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { BellRing, Check, CircleHelp, Clock, ListTodo, Pencil, Plus, RotateCcw, Sparkles, Trash2, X } from 'lucide-preact';
import { engineName, message, openEntry, toast } from '../actions.ts';
import { api, qs } from '../api.ts';
import { fmtDate, plural, speakerName } from '../format.ts';
import { useApp } from '../store.ts';
import type { AskResult, AskStreamEvent } from '../types.ts';
import { Button } from '../ui/common.tsx';
import { type Brief, type Loop, type NewTask, onPaChange, pa, type PaTask } from './api.ts';
import { countsLine, dayOn, dueLabel, fmtRemind, fromLocalInput, localDay, olderLine, openLine, toLocalInput } from './text.ts';
import './pa.css';

const KIND: Record<Loop['kind'], string> = {
  promise: 'You promised',
  todo: 'To do',
  waiting: 'Waiting on',
  reminder: 'Reminder',
};

/** Loads with `load`, and again whenever the record or the assistant's data changes. */
function useLoad<T>(load: () => Promise<T>, keys: unknown[]): { data: T | null; error: string | null; setData: (d: T) => void } {
  const revision = useApp((s) => s.revision);
  const [changes, setChanges] = useState(0);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => onPaChange(() => setChanges((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    load().then(
      (d) => live && (setData(d), setError(null)),
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
    // `load` closes over the keys, which are the dependencies.
  }, [revision, changes, ...keys]);
  return { data, error, setData };
}

/** A reminder input's value as a moment (null when empty), or undefined after saying what is wrong with it. */
function readMoment(value: string): string | null | undefined {
  try {
    return fromLocalInput(value);
  } catch (error) {
    toast(message(error), { tone: 'error' });
    return undefined;
  }
}

/** Runs a change and says how it went. */
function run<T>(call: Promise<T>, done: string | ((value: T) => string)): void {
  call.then(
    (value) => toast(typeof done === 'string' ? done : done(value)),
    (error: unknown) => toast(message(error), { tone: 'error' }),
  );
}

function Card({ id, title, meta, actions, children }: { id: string; title: string; meta?: ComponentChildren; actions?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="card pa-card" aria-labelledby={id}>
      <header class="pa-card-head">
        <h2 id={id}>{title}</h2>
        {meta && <span class="soft small pa-meta">{meta}</span>}
        {actions && <span class="pa-card-actions">{actions}</span>}
      </header>
      {children}
    </section>
  );
}

/** Entry ids as small buttons that open the entry. */
function Cites({ ids }: { ids: number[] }) {
  if (!ids.length) return null;
  return (
    <span class="pa-cites">
      {ids.map((id) => (
        <button key={id} type="button" class="pa-cite" onClick={() => openEntry(id)} aria-label={`Open entry ${id}`} title="Open the entry">
          {id}
        </button>
      ))}
    </span>
  );
}

function Section({ title, rows }: { title: string; rows: { id: number; text: string; meta: string }[] }) {
  if (!rows.length) return null;
  return (
    <div class="pa-section">
      <h3>{title}</h3>
      <ul class="pa-links">
        {rows.map((r, i) => (
          <li key={`${r.id}-${i}`}>
            <button type="button" class="pa-link" onClick={() => openEntry(r.id)}>
              <span>{r.text}</span>
              <span class="soft small">{r.meta}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BriefView({ brief }: { brief: Brief }) {
  const b = brief.body;
  const older = olderLine(b);
  return (
    <div class="pa-brief">
      <p>
        {countsLine(b)}
        {older && <> {older}</>}
      </p>
      {b.lines.length > 0 && (
        <div class="model-answer">
          <ul class="pa-lines">
            {b.lines.map((l, i) => (
              <li key={i}>
                {l.text} <Cites ids={l.cites} />
              </li>
            ))}
          </ul>
          <p class="band small">The model’s reading of these entries, not your words · {engineName(brief.engine, brief.model)}</p>
        </div>
      )}
      <Section title="Worked on" rows={b.threads.map((t) => ({ id: t.entryId, text: t.title || 'Untitled', meta: `${t.source} · ${plural(t.entries, 'entry', 'entries')}` }))} />
      <Section title="Decided" rows={b.decided.map((d) => ({ id: d.entryId, text: `“${d.quote}”`, meta: d.where }))} />
      <Section title="New loops" rows={b.loops.map((l) => ({ id: l.entryId, text: l.what, meta: KIND[l.kind as Loop['kind']] ?? l.kind }))} />
      <Section title="Questions you left" rows={b.questions.map((q) => ({ id: q.entryId, text: `“${q.quote}”`, meta: q.where }))} />
      <p class="soft small">{openLine(b)}</p>
    </div>
  );
}

function BriefCard() {
  const { data: today, error } = useLoad(pa.today, []);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const make = () => {
    setBusy(true);
    setNote(null);
    pa.brief()
      .then(
        (r) => setNote(r.message),
        (e: unknown) => toast(message(e), { tone: 'error' }),
      )
      .finally(() => setBusy(false));
  };
  const brief = today?.brief ?? null;
  const fresh = !brief || (today?.newSinceBrief ?? 0) > 0;
  return (
    <Card
      id="pa-brief-h"
      title="Brief"
      meta={brief && `${fmtDate(brief.createdAt)} · ${engineName(brief.engine, brief.model)}`}
      actions={
        <Button small kind={fresh ? 'primary' : 'quiet'} icon={Sparkles} onClick={make} disabled={busy} aria-busy={busy}>
          {busy ? 'Writing…' : 'Make a brief'}
        </Button>
      }
    >
      {error && <p class="error-text">{error}</p>}
      <p class="soft small pa-note" role="status">
        {note}
      </p>
      {today && brief && today.newSinceBrief > 0 && <p class="soft small">{plural(today.newSinceBrief, 'entry', 'entries')} new or changed since this brief.</p>}
      {today && !brief && (
        <p class="soft">No brief yet. A brief gathers what came into your record since the last one: the threads you worked on, what you decided, new loops and the questions you left.</p>
      )}
      {brief && <BriefView brief={brief} />}
    </Card>
  );
}

/** The answer while the model writes it: the text so far (already cleaned by the server) and what the model is doing. */
interface Draft {
  text: string;
  status: string;
}

function AskAnswer({ view, draft }: { view: AskResult; draft: Draft | null }) {
  return (
    <div class="pa-answer">
      {draft ? (
        <div class="model-answer">
          {draft.text && <p>{draft.text}</p>}
          <p class="band small">{draft.status} · the model’s reading of these entries, not your words</p>
        </div>
      ) : (
        view.answer && (
          <div class="model-answer">
            <p>
              {view.answer} <Cites ids={view.cites} />
            </p>
            <p class="band small">The model’s reading of these entries, not your words · {engineName(view.engine, view.model)}</p>
          </div>
        )
      )}
      {view.message && <p class="soft small">{view.message}</p>}
      {view.hits.length === 0 ? (
        <p class="soft">Nothing in your record matches that.</p>
      ) : (
        <>
          {!view.answer && !draft && <p class="soft small">Found by search and dates. No model wrote this.</p>}
          <ul class="hits">
            {view.hits.slice(0, 8).map((h) => (
              <li key={h.entryId}>
                <button type="button" class="hit" onClick={() => openEntry(h.entryId)}>
                  <span class="hit-title">
                    {h.where || 'Untitled'}
                    {view.cites.includes(h.entryId) && <span class="tag">Cited</span>}
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
    </div>
  );
}

// The question goes to GET /api/ask/stream (src/server/ask-stream.ts): the entries found show at once, then the
// answer as the model writes it, then the checked answer in its place. Stop, or leaving the view, closes the
// connection, which stops the model; the entries found stay.
function AskCard() {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AskResult | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asking = useRef<AbortController | null>(null);
  useEffect(() => () => asking.current?.abort(), []);
  const submit = (e: Event) => {
    e.preventDefault();
    const question = q.trim();
    if (!question || busy) return;
    const stop = new AbortController();
    asking.current = stop;
    let ended = false;
    setBusy(true);
    setAnswer(null);
    setDraft(null);
    setNote(null);
    setError(null);
    const show = (event: AskStreamEvent) => {
      if (event.type === 'hits') setAnswer(event.result);
      else if (event.type === 'status') setDraft((d) => ({ text: d?.text ?? '', status: event.line }));
      else if (event.type === 'text') setDraft((d) => ({ status: d?.status ?? '', text: (d?.text ?? '') + event.text }));
      else if (event.type === 'restart') setDraft((d) => ({ status: d?.status ?? '', text: '' }));
      else {
        ended = true;
        setDraft(null);
        if (event.type === 'done') setAnswer(event.result);
        else setError(event.message);
      }
    };
    api
      .stream<AskStreamEvent>(`ask/stream${qs({ q: question })}`, show, stop.signal)
      .then(() => {
        if (!ended) throw new Error('The answer stopped before it was finished.');
      })
      .catch((err: unknown) => {
        setDraft(null);
        if (stop.signal.aborted) setNote('Stopped. The entries found stay.');
        else setError(message(err));
      })
      .finally(() => {
        if (asking.current === stop) asking.current = null;
        setBusy(false);
      });
  };
  return (
    <Card id="pa-ask-h" title="Ask your record">
      <form class="pa-form" role="search" aria-label="Ask your record" onSubmit={submit}>
        <label class="sr-only" for="pa-ask">
          Your question
        </label>
        <input id="pa-ask" type="text" value={q} maxLength={2000} placeholder="What did I decide about the stall?" onInput={(e) => setQ(e.currentTarget.value)} />
        <Button type="submit" small kind="primary" icon={CircleHelp} disabled={busy || !q.trim()} aria-busy={busy}>
          {busy ? 'Asking…' : 'Ask'}
        </Button>
        {busy && (
          <Button small icon={X} onClick={() => asking.current?.abort()}>
            Stop
          </Button>
        )}
      </form>
      {error && (
        <p class="error-text" role="alert">
          {error}
        </p>
      )}
      {/* Busy while the answer is written, so a screen reader reads it once it is checked, not piece by piece. */}
      <div aria-live="polite" aria-busy={busy}>
        {note && <p class="soft small">{note}</p>}
        {answer && <AskAnswer view={answer} draft={draft} />}
      </div>
    </Card>
  );
}

function LoopRow({ loop: l, today }: { loop: Loop; today: string }) {
  const [snoozing, setSnoozing] = useState(false);
  const [until, setUntil] = useState(() => dayOn(today, 7));
  const open = l.state === 'open';
  const due = l.dueDay ? dueLabel(l.dueDay, today) : null;
  const formId = `pa-snooze-${l.key}`;
  return (
    <li class={`pa-item${open ? '' : ' pa-closed'}`}>
      <div class="pa-item-main">
        <span class="pa-item-title">{l.what}</span>
        <span class="pa-tags">
          <span class="tag">{KIND[l.kind]}</span>
          {l.who && <span class="tag">{l.who}</span>}
          {due && <span class={`tag${due.late && open ? ' pa-late' : ''}`}>{due.late ? due.text : `due ${due.text}`}</span>}
          {open && l.followUp && <span class="tag pa-follow">Follow up</span>}
          {!open && <span class="tag">{l.untilDay ? `snoozed until ${l.untilDay}` : l.state}</span>}
          {l.taskId !== null && <span class="tag tag-ok">Task {l.taskId}</span>}
          {l.by !== 'none' && <span class="tag">Read by the {l.by} model</span>}
        </span>
        <button type="button" class="pa-quote" onClick={() => openEntry(l.entryId)}>
          “{l.quote}” <span class="soft small">{l.where}, {fmtDate(l.date)}</span>
        </button>
        {l.closedBy && (
          <button type="button" class="pa-quote soft small" onClick={() => openEntry(l.closedBy!.entryId)}>
            Closed by “{l.closedBy.quote}”
          </button>
        )}
      </div>
      <div class="pa-item-actions">
        {open ? (
          <>
            <Button small kind="quiet" icon={Check} aria-label={`Done: ${l.what}`} onClick={() => run(pa.setLoop(l.key, 'done'), `Done: ${l.what}`)}>
              Done
            </Button>
            <Button small kind="quiet" icon={Clock} aria-expanded={snoozing} aria-controls={formId} aria-label={`Snooze: ${l.what}`} onClick={() => setSnoozing(!snoozing)}>
              Snooze
            </Button>
            {l.taskId === null && (
              <Button small kind="quiet" icon={ListTodo} aria-label={`Make a task: ${l.what}`} onClick={() => run(pa.loopTask(l.key), (t) => `Task added: ${t.title}`)}>
                Make a task
              </Button>
            )}
            <Button small kind="quiet" icon={X} aria-label={`Drop: ${l.what}`} title="Drop" onClick={() => run(pa.setLoop(l.key, 'dropped'), `Dropped: ${l.what}`)} />
          </>
        ) : (
          <Button small kind="quiet" icon={RotateCcw} aria-label={`Reopen: ${l.what}`} onClick={() => run(pa.setLoop(l.key, 'open'), `Reopened: ${l.what}`)}>
            Reopen
          </Button>
        )}
      </div>
      <form
        id={formId}
        class="pa-form pa-inline"
        hidden={!snoozing}
        onSubmit={(e) => {
          e.preventDefault();
          setSnoozing(false);
          run(pa.setLoop(l.key, 'snoozed', until), `Snoozed until ${until}: ${l.what}`);
        }}
      >
        <label class="field-label" for={`${formId}-day`}>
          Until
        </label>
        <input id={`${formId}-day`} type="date" value={until} min={dayOn(today, 1)} required onInput={(e) => setUntil(e.currentTarget.value)} />
        <Button type="submit" small kind="primary">
          Snooze
        </Button>
      </form>
    </li>
  );
}

function LoopsCard() {
  const [all, setAll] = useState(false);
  const engine = useApp((s) => s.config?.ai.engine ?? 'none');
  const { data, error, setData } = useLoad(() => pa.loops(all), [all]);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const today = localDay();
  const read = () => {
    setReading(true);
    setNote(null);
    pa.readLoops(all)
      .then(
        (r) => {
          setData(r);
          setNote(r.message ?? (r.read && r.read.read ? `The model read ${plural(r.read.read, 'sentence')} and found ${plural(r.read.loops, 'loop')}.` : 'The model has read every sentence already.'));
        },
        (e: unknown) => toast(message(e), { tone: 'error' }),
      )
      .finally(() => setReading(false));
  };
  return (
    <Card
      id="pa-loops-h"
      title="Open loops"
      meta={data && `${data.counts.open} open · ${data.counts.followUp} to follow up`}
      actions={
        <>
          <label class="pa-toggle">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.currentTarget.checked)} /> Closed too
          </label>
          {engine !== 'none' && (
            <Button small kind="quiet" icon={Sparkles} onClick={read} disabled={reading} aria-busy={reading}>
              {reading ? 'Reading…' : 'Read with the model'}
            </Button>
          )}
        </>
      }
    >
      <p class="soft small">Promises, to-dos, waits and reminders in your own words, from the last 30 days.</p>
      <p class="soft small pa-note" role="status">
        {note}
      </p>
      {error && <p class="error-text">{error}</p>}
      {data && !data.loops.length && <p class="soft">{all ? 'No loops in the last 30 days.' : 'No open loops in the last 30 days.'}</p>}
      {data && data.loops.length > 0 && (
        <ul class="pa-list">
          {data.loops.map((l) => (
            <LoopRow key={l.key} loop={l} today={today} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function AddTask() {
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [remind, setRemind] = useState('');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = (e: Event) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    const body: NewTask = { text };
    if (due) body.dueDay = due;
    const remindAt = readMoment(remind);
    if (remindAt === undefined) return;
    if (remindAt) body.remindAt = remindAt;
    setBusy(true);
    pa.addTask(body)
      .then(
        (t) => {
          setText('');
          setDue('');
          setRemind('');
          toast(`Task added: ${t.title}${t.dueDay ? `, due ${t.dueDay}` : ''}${t.remindAt ? `, reminder ${fmtRemind(t.remindAt)}` : ''}`);
        },
        (err: unknown) => toast(message(err), { tone: 'error' }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <form class="pa-add" aria-label="Add a task" onSubmit={submit}>
      <div class="pa-form">
        <label class="sr-only" for="pa-add-text">
          New task
        </label>
        <input id="pa-add-text" type="text" value={text} maxLength={600} placeholder="Call Ana tomorrow at 3" onInput={(e) => setText(e.currentTarget.value)} />
        <Button type="submit" small kind="primary" icon={Plus} disabled={busy || !text.trim()}>
          Add
        </Button>
        <Button small kind="quiet" icon={BellRing} aria-expanded={more} aria-controls="pa-add-more" onClick={() => setMore(!more)}>
          Day and reminder
        </Button>
      </div>
      <div id="pa-add-more" class="pa-form pa-inline" hidden={!more}>
        <label class="field-label" for="pa-add-due">
          Due
        </label>
        <input id="pa-add-due" type="date" value={due} onInput={(e) => setDue(e.currentTarget.value)} />
        <label class="field-label" for="pa-add-remind">
          Remind me
        </label>
        <input id="pa-add-remind" type="datetime-local" value={remind} onInput={(e) => setRemind(e.currentTarget.value)} />
      </div>
      <p class="field-hint">Words like “by Friday” or “tomorrow at 3” set the day and the reminder.</p>
    </form>
  );
}

function TaskEdit({ task: t, onClose }: { task: PaTask; onClose: () => void }) {
  const [title, setTitle] = useState(t.title);
  const [notes, setNotes] = useState(t.notes);
  const [due, setDue] = useState(t.dueDay ?? '');
  const [remind, setRemind] = useState(toLocalInput(t.remindAt));
  const id = `pa-edit-${t.id}`;
  const save = (e: Event) => {
    e.preventDefault();
    const remindAt = readMoment(remind);
    if (remindAt === undefined) return;
    pa.updateTask(t.id, { title, notes, dueDay: due || null, remindAt }).then(onClose, (err: unknown) => toast(message(err), { tone: 'error' }));
  };
  return (
    <form
      class="pa-edit"
      aria-label={`Edit the task: ${t.title}`}
      onSubmit={save}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <label class="field">
        <span class="field-label">Task</span>
        <input id={`${id}-title`} type="text" value={title} maxLength={300} required autoFocus onInput={(e) => setTitle(e.currentTarget.value)} />
      </label>
      <div class="pa-form pa-inline">
        <label class="field-label" for={`${id}-due`}>
          Due
        </label>
        <input id={`${id}-due`} type="date" value={due} onInput={(e) => setDue(e.currentTarget.value)} />
        <label class="field-label" for={`${id}-remind`}>
          Remind me
        </label>
        <input id={`${id}-remind`} type="datetime-local" value={remind} onInput={(e) => setRemind(e.currentTarget.value)} />
      </div>
      <label class="field">
        <span class="field-label">Notes</span>
        <textarea rows={2} value={notes} maxLength={5000} onInput={(e) => setNotes(e.currentTarget.value)} />
      </label>
      <div class="row">
        <Button type="submit" small kind="primary">
          Save
        </Button>
        <Button small kind="quiet" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TaskRow({ task: t, today }: { task: PaTask; today: string }) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <li class="pa-item">
        <TaskEdit task={t} onClose={() => setEditing(false)} />
      </li>
    );
  const open = t.status === 'open';
  const due = t.dueDay ? dueLabel(t.dueDay, today) : null;
  const ringing = open && t.remindAt !== null && t.remindedAt === null && t.remindAt <= new Date().toISOString();
  return (
    <li class={`pa-item${open ? '' : ' pa-closed'}`}>
      <div class="pa-item-main">
        <label class="pa-check">
          <input
            type="checkbox"
            checked={t.status === 'done'}
            onChange={(e) => {
              const done = e.currentTarget.checked;
              run(pa.updateTask(t.id, { status: done ? 'done' : 'open' }), done ? `Done: ${t.title}` : `Reopened: ${t.title}`);
            }}
          />
          <span class="pa-item-title">{t.title}</span>
        </label>
        <span class="pa-tags">
          {due && <span class={`tag${due.late && open ? ' pa-late' : ''}`}>{due.late ? due.text : `due ${due.text}`}</span>}
          {open && t.remindAt && (
            <span class={`tag${ringing ? ' pa-follow' : ''}`}>
              <BellRing size={12} aria-hidden="true" /> {fmtRemind(t.remindAt)}
              {t.remindedAt ? ' (dismissed)' : ''}
            </span>
          )}
          {t.status === 'dropped' && <span class="tag">dropped</span>}
          {t.entryId !== null && (
            <button type="button" class="tag pa-tag-link" onClick={() => openEntry(t.entryId!)}>
              From your words
            </button>
          )}
        </span>
        {t.notes && <p class="soft small pa-notes">{t.notes}</p>}
      </div>
      <div class="pa-item-actions">
        <Button small kind="quiet" icon={Pencil} aria-label={`Edit: ${t.title}`} title="Edit" onClick={() => setEditing(true)} />
        {open && <Button small kind="quiet" icon={X} aria-label={`Drop: ${t.title}`} title="Drop" onClick={() => run(pa.updateTask(t.id, { status: 'dropped' }), `Dropped: ${t.title}`)} />}
        {t.status === 'dropped' && (
          <Button small kind="quiet" icon={RotateCcw} aria-label={`Reopen: ${t.title}`} title="Reopen" onClick={() => run(pa.updateTask(t.id, { status: 'open' }), `Reopened: ${t.title}`)} />
        )}
        <Button small kind="quiet" icon={Trash2} aria-label={`Delete: ${t.title}`} title="Delete" onClick={() => run(pa.deleteTask(t.id), `Deleted: ${t.title}`)} />
      </div>
    </li>
  );
}

function TasksCard() {
  const [all, setAll] = useState(false);
  const { data, error } = useLoad(() => pa.tasks(all), [all]);
  const today = localDay();
  return (
    <Card
      id="pa-tasks-h"
      title="Tasks"
      meta={data && !all && plural(data.length, 'open task')}
      actions={
        <label class="pa-toggle">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.currentTarget.checked)} /> Done too
        </label>
      }
    >
      <AddTask />
      {error && <p class="error-text">{error}</p>}
      {data && !data.length && <p class="soft">{all ? 'No tasks yet.' : 'No open tasks.'}</p>}
      {data && data.length > 0 && (
        <ul class="pa-list">
          {data.map((t) => (
            <TaskRow key={t.id} task={t} today={today} />
          ))}
        </ul>
      )}
      <p class="soft small">Reminders show in this app while it is open. Nothing runs in the background.</p>
    </Card>
  );
}

/** The Assistant view. */
export function AssistantView() {
  return (
    <section class="view pa" aria-label="Assistant">
      <header class="view-head">
        <h1>Assistant</h1>
        <p class="soft">Your brief, loops and tasks, from your own words. Each part works with no model.</p>
      </header>
      <div class="pa-body">
        <div class="pa-col">
          <BriefCard />
          <AskCard />
        </div>
        <div class="pa-col">
          <LoopsCard />
          <TasksCard />
        </div>
      </div>
    </section>
  );
}
