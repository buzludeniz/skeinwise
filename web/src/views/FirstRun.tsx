// First run: Set up, Bring in, Watch it grow. Each check is real; what this build can't do yet says so.

import { useEffect, useState } from 'preact/hooks';
import { Check, CircleDashed, LoaderCircle, TriangleAlert } from 'lucide-preact';
import { loadRecord, message, organise, saveConfig, toast } from '../actions.ts';
import { api } from '../api.ts';
import { growOnNextLoad } from '../brain/useBrain.ts';
import { fmtNum, fmtRange, plural } from '../format.ts';
import { getState, setState, useApp } from '../store.ts';
import type { Agent, Found, ImportResult, Preview } from '../types.ts';
import { Button, Kbd, Logo, MOD, useFocusTrap } from '../ui/common.tsx';
import { importSummary } from '../upload.ts';

type Step = 'setup' | 'bring' | 'grow';
type LineState = 'wait' | 'busy' | 'done' | 'warn';
type FoundRow = Found & { decision: 'in' | 'out' | 'later' | null };

const STEPS: [Step, string][] = [
  ['setup', 'Set up'],
  ['bring', 'Bring in'],
  ['grow', 'Watch it grow'],
];

function finish() {
  setState({ firstRun: false });
  void saveConfig({ firstRunDone: true }, true);
}

function Mark({ state }: { state: LineState }) {
  if (state === 'done') return <Check size={16} class="ok-text" aria-label="Done" />;
  if (state === 'busy') return <LoaderCircle size={16} class="spin" aria-label="Working" />;
  if (state === 'warn') return <TriangleAlert size={16} class="warn-text" aria-label="Needs a look" />;
  return <CircleDashed size={16} class="soft" aria-label="Waiting" />;
}

function Steps({ step }: { step: Step }) {
  return (
    <ol class="fr-steps" aria-label="Steps">
      {STEPS.map(([key, label], i) => (
        <li key={key} class={key === step ? 'on' : STEPS.findIndex(([k]) => k === step) > i ? 'done' : ''} aria-current={key === step ? 'step' : undefined}>
          {label}
        </li>
      ))}
    </ol>
  );
}

function SetUp({ onNext }: { onNext: () => void }) {
  const status = useApp((s) => s.status);
  const config = useApp((s) => s.config);
  const [lines, setLines] = useState<Record<string, LineState>>({ command: 'wait', record: 'wait', servers: 'wait', model: 'wait' });
  const [modelNote, setModelNote] = useState('');
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set(config?.agents.chosen ?? []));
  const [ran, setRan] = useState(false);

  useEffect(() => {
    api.get<Agent[]>('agents').then(
      (a) => {
        setAgents(a);
        if (!config?.agents.chosen.length) setChosen(new Set(a.filter((x) => x.found).map((x) => x.key)));
      },
      () => setAgents([]),
    );
  }, []);

  const mark = (key: string, state: LineState) => setLines((l) => ({ ...l, [key]: state }));
  const pause = () => new Promise((r) => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350));

  const run = async () => {
    setRan(true);
    mark('command', 'busy');
    await pause();
    mark('command', 'done');
    mark('record', 'busy');
    try {
      await api.get('status');
      mark('record', 'done');
    } catch {
      mark('record', 'warn');
    }
    await pause();
    mark('servers', 'done');
    mark('model', 'busy');
    try {
      const t = await api.get<{ ok: boolean; message: string }>('model/test');
      mark('model', t.ok ? 'done' : 'warn');
      setModelNote(t.ok ? t.message : `${t.message} Skeinwise works without it, and you can test again in Settings.`);
    } catch (error) {
      mark('model', 'warn');
      setModelNote(message(error));
    }
    await saveConfig({ agents: { chosen: [...chosen] } }, true);
  };

  const done = ran && Object.values(lines).every((s) => s !== 'busy' && s !== 'wait');

  return (
    <>
      <h1>Set up Skeinwise</h1>
      <p>Everything stays on this computer. This is what Skeinwise uses:</p>
      <ul class="fr-lines">
        <li>
          <Mark state={lines.command!} />
          <span>
            The <code>skeinwise</code> command, which is serving this page
          </span>
        </li>
        <li>
          <Mark state={lines.record!} />
          <span>
            Your record, readable only by this user account
            {status ? <span class="soft"> · {plural(status.entries, 'entry', 'entries')} so far</span> : null}
          </span>
        </li>
        <li>
          <Mark state={lines.servers!} />
          <span>
            Two MCP servers for your AI agents: memory over your record, and a way to steer this app's view
            <span class="soft block">
              To give an agent your record as its memory, run <code>skeinwise connect claude-code</code> in a terminal,
              with codex, cursor or claude-desktop in place of claude-code for the others.
            </span>
          </span>
        </li>
        <li>
          <Mark state={lines.model!} />
          <span>
            The local model: <code>{config?.ai.local.model}</code> at {config?.ai.local.address}
            {modelNote && <span class="soft block">{modelNote}</span>}
          </span>
        </li>
      </ul>
      <fieldset class="fr-agents">
        <legend>Agents found on this computer</legend>
        {!agents ? (
          <p class="soft">Looking…</p>
        ) : (
          agents.map((a) => (
            <label key={a.key} class="check">
              <input
                type="checkbox"
                checked={chosen.has(a.key)}
                disabled={!a.found || ran}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if ((e.currentTarget as HTMLInputElement).checked) next.add(a.key);
                  else next.delete(a.key);
                  setChosen(next);
                }}
              />
              <span>{a.label}</span>
              {!a.found && <span class="soft small">not found</span>}
            </label>
          ))
        )}
      </fieldset>
      <div class="fr-actions">
        <Button kind="quiet" onClick={finish}>
          Skip for now
        </Button>
        {done ? (
          <Button kind="primary" onClick={onNext}>
            Next: bring things in
          </Button>
        ) : (
          <Button kind="primary" onClick={() => void run()} disabled={ran}>
            {ran ? 'Setting up…' : 'Set it up'}
          </Button>
        )}
      </div>
    </>
  );
}

function SourceCard({ found, owner, onOwner }: { found: FoundRow; owner: string; onOwner: (o: string) => void }) {
  const config = useApp((s) => s.config);
  const decision = config?.bringIn[found.path] ?? found.decision;
  const [preview, setPreview] = useState<Preview | null | 'error'>(null);
  useEffect(() => {
    api.post<Preview>('found/preview', { path: found.path }).then(setPreview, () => setPreview('error'));
  }, [found.path]);
  const choose = (d: 'in' | 'out' | 'later') => void saveConfig({ bringIn: { ...(config?.bringIn ?? {}), [found.path]: d } }, true);
  return (
    <li class={`card fr-card${decision ? ` chose-${decision}` : ''}`}>
      <strong>{found.label}</strong>
      <p class="soft small">
        {preview === null
          ? 'Counting…'
          : preview === 'error'
            ? found.detail
            : `${plural(preview.entries, 'entry', 'entries')}${preview.threads ? ` in ${plural(preview.threads, 'thread')}` : ''}${preview.first ? ` · ${fmtRange(preview.first, preview.last)}` : ''}`}
        {found.inRecord && ' · already in the record'}
      </p>
      {found.asksOwner && (
        <label class="field field-inline">
          <span class="field-label">Whose words?</span>
          <input value={owner === 'you' ? '' : owner} placeholder="Mine" aria-label="Whose words? Leave empty for your own" onInput={(e) => onOwner((e.currentTarget as HTMLInputElement).value.trim() || 'you')} />
        </label>
      )}
      <div class="segmented" role="radiogroup" aria-label={`What to do with ${found.label}`}>
        {(
          [
            ['in', 'Bring it in'],
            ['out', 'Keep it out'],
            ['later', 'Later'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={decision === k} class={decision === k ? 'on' : ''} onClick={() => choose(k)}>
            {label}
          </button>
        ))}
      </div>
    </li>
  );
}

function BringIn({ onNext, owners, setOwners }: { onNext: () => void; owners: Record<string, string>; setOwners: (o: Record<string, string>) => void }) {
  const [found, setFound] = useState<FoundRow[] | null>(null);
  useEffect(() => {
    api.get<FoundRow[]>('found').then(setFound, () => setFound([]));
  }, []);
  return (
    <>
      <h1>Bring in</h1>
      <p>These are on this computer. Choose what goes into the record. The original files are never changed.</p>
      {!found ? (
        <p class="soft">Looking for chats, exports and notes…</p>
      ) : found.length === 0 ? (
        <p class="soft">Nothing found yet. You can add files any time from Add, or drop them on the window.</p>
      ) : (
        <ul class="fr-cards">
          {found.map((f) => (
            <SourceCard key={f.id} found={f} owner={owners[f.path] ?? 'you'} onOwner={(o) => setOwners({ ...owners, [f.path]: o })} />
          ))}
        </ul>
      )}
      <div class="fr-actions">
        <Button kind="quiet" onClick={finish}>
          Skip for now
        </Button>
        <Button kind="primary" onClick={onNext}>
          Next: watch it grow
        </Button>
      </div>
    </>
  );
}

function useCount(target: number, ms = 3500): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setN(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      setN(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return n;
}

function Grow({ owners }: { owners: Record<string, string> }) {
  const brain = useApp((s) => s.brain);
  const hubs = useApp((s) => s.organiser.hubs.length);
  const organiserReady = useApp((s) => s.organiser.ready);
  const job = useApp((s) => s.job);
  const [phase, setPhase] = useState<'importing' | 'done'>('importing');
  const [note, setNote] = useState('');
  const box = useFocusTrap(phase === 'done');

  useEffect(() => {
    let live = true;
    (async () => {
      const found = await api.get<FoundRow[]>('found').catch(() => [] as FoundRow[]);
      const chosen = getState().config?.bringIn ?? {};
      const todo = found.filter((f) => chosen[f.path] === 'in' && !f.inRecord);
      const results: ImportResult[] = [];
      for (const f of todo) {
        if (!live) return;
        setNote(`Reading ${f.label}…`);
        try {
          results.push(...(await api.post<ImportResult[]>('import', { path: f.path, owner: owners[f.path] ?? 'you' })));
        } catch (error) {
          toast(`${f.label}: ${message(error)}`, { tone: 'error' });
        }
      }
      growOnNextLoad();
      await loadRecord();
      if (!live) return;
      setNote(todo.length ? importSummary(results) : 'Your record, point by point, oldest first.');
      // The first organising pass, with the engine set in Settings. A model run can take a while: it carries on after
      // Done, and its progress shows wherever runs are shown.
      const s = getState();
      const organised = s.organiser.runs.some((r) => r.task !== 'correction' && r.task !== 'ask');
      if (s.brain?.points.length && !organised) void organise({ task: 'all', scope: 'all' }).catch((error: unknown) => toast(message(error), { tone: 'error' }));
      setTimeout(() => live && setPhase('done'), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 3800);
    })();
    return () => {
      live = false;
    };
  }, []);

  const entries = brain?.points.length ?? 0;
  const threads = brain ? new Set(brain.points.map((p) => p[4]).filter((t) => t > 0)).size : 0;
  const shownEntries = useCount(entries);
  const shownThreads = useCount(threads);

  return (
    <div class="fr-grow" role="dialog" aria-label="Watch it grow" ref={box}>
      <Steps step="grow" />
      <div class="counters" aria-live="polite">
        <div>
          <strong>{fmtNum(shownEntries)}</strong>
          <span>entries</span>
        </div>
        <div>
          <strong>{fmtNum(shownThreads)}</strong>
          <span>threads</span>
        </div>
        <div>
          <strong>{organiserReady ? fmtNum(hubs) : '–'}</strong>
          <span>hubs</span>
        </div>
      </div>
      <p class="soft small">{note}</p>
      {job && !job.finished ? (
        <p class="soft small" aria-live="polite">
          Organising: {job.line ?? 'starting…'}
        </p>
      ) : (
        phase === 'done' &&
        hubs === 0 && <p class="soft small">Hubs appear once the organiser has run. Start it any time from Runs in Threads, or type “organise” in the command bar.</p>
      )}
      {phase === 'done' && (
        <>
          <ol class="tips">
            <li>Drag to turn the brain. Scroll or pinch to zoom. Double-click a point to read it.</li>
            <li>
              <Kbd>{MOD}K</Kbd> searches, answers questions and runs commands.
            </li>
            <li>
              Keys <Kbd>1</Kbd> to <Kbd>8</Kbd> move between views. Guide, on <Kbd>7</Kbd>, explains the shapes.
            </li>
          </ol>
          <div class="fr-actions">
            <Button kind="primary" onClick={finish}>
              Done
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function FirstRun() {
  const [step, setStep] = useState<Step>('setup');
  const [owners, setOwners] = useState<Record<string, string>>({});
  const box = useFocusTrap(step !== 'grow');

  if (step === 'grow') return <Grow owners={owners} />;
  return (
    <div class="cover first-run modal-open" role="dialog" aria-modal="true" aria-label="First run">
      <div class="fr-card-main" ref={box}>
        <header class="fr-head">
          <Logo size={34} />
          <Steps step={step} />
        </header>
        {step === 'setup' ? <SetUp onNext={() => setStep('bring')} /> : <BringIn onNext={() => setStep('grow')} owners={owners} setOwners={setOwners} />}
      </div>
    </div>
  );
}
