// Settings: the groups from docs/ui.md, top to bottom, plus Live capture's own settings under AI model. Each change
// saves at once; a note says where a setting isn't acted on yet.

import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Archive, Check, Copy, FlaskConical, X } from 'lucide-preact';
import { message, saveConfig, setTheme, toast } from '../actions.ts';
import { api } from '../api.ts';
import { fmtBytes, fmtNum } from '../format.ts';
import { setState, useApp } from '../store.ts';
import { contrast, PALETTES, pointColors, THEMES } from '../themes.ts';
import type { Agent, Config } from '../types.ts';
import { Button, Segmented, Switch, useFocusTrap } from './common.tsx';

const GROUPS = ['Sync', 'AI agents', 'AI model', 'Usage cap', 'Proof of date', 'Backup', 'Exclusions', 'Appearance'] as const;

const LATER_NOTE = 'Comes in version 0.5. The choice is kept until then.';

function slug(g: string): string {
  return `set-${g.toLowerCase().replace(/[^a-z]+/g, '-')}`;
}

function Group({ title, children }: { title: (typeof GROUPS)[number]; children: ComponentChildren }) {
  return (
    <section class="set-group" id={slug(title)} aria-labelledby={`${slug(title)}-h`}>
      <h3 id={`${slug(title)}-h`}>{title}</h3>
      {children}
    </section>
  );
}

/** A text field that saves when it loses focus or Enter is pressed. */
function Field({
  label,
  value,
  onSave,
  placeholder,
  type = 'text',
  hint,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'number';
  hint?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value) onSave(v);
  };
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      <input
        inputMode={type === 'number' ? 'numeric' : undefined}
        value={v}
        placeholder={placeholder}
        spellcheck={false}
        onInput={(e) => setV((e.currentTarget as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  );
}

function Note({ children }: { children: ComponentChildren }) {
  return <p class="set-note">{children}</p>;
}

function Agents({ config }: { config: Config }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  useEffect(() => {
    api.get<Agent[]>('agents').then(setAgents, () => setAgents([]));
  }, []);
  const chosen = new Set(config.agents.chosen);
  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(key);
    else next.delete(key);
    void saveConfig({ agents: { chosen: [...next] } });
  };
  return (
    <>
      {!agents ? (
        <p class="soft">Looking for agents…</p>
      ) : (
        <ul class="agent-list">
          {agents.map((a) => (
            <li key={a.key}>
              <label class="check">
                <input type="checkbox" checked={chosen.has(a.key)} disabled={!a.found} onChange={(e) => toggle(a.key, (e.currentTarget as HTMLInputElement).checked)} />
                <span>{a.label}</span>
                <span class="soft small">{a.found ? 'Found on this computer' : 'Not found'}</span>
              </label>
              <Button icon={Copy} small kind="quiet" disabled title="The memory server comes in version 0.5">
                Copy config
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Note>Agents will reach the record through the memory server, which comes in version 0.5. Ticked agents are the ones it will offer to connect.</Note>
      <Button
        icon={Copy}
        small
        onClick={() => {
          void navigator.clipboard
            .writeText('Look in my Skeinwise record: when did I first write about this project, and what did I decide?')
            .then(() => toast('Copied a sample question.', { tone: 'ok' }), () => toast('The browser wouldn’t let the page copy.', { tone: 'error' }));
        }}
      >
        Copy a sample question
      </Button>
    </>
  );
}

function Model({ config }: { config: Config }) {
  const ai = config.ai;
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const run = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.get<{ ok: boolean; message: string }>('model/test'));
    } catch (error) {
      setTest({ ok: false, message: message(error) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <Segmented
        label="Which model"
        options={[
          ['local', 'Local model'],
          ['remote', 'Outside model'],
          ['none', 'No AI'],
        ]}
        value={ai.engine}
        onChange={(engine) => void saveConfig({ ai: { engine } })}
      />
      {ai.engine === 'local' && (
        <div class="fields">
          <Field label="Address" value={ai.local.address} onSave={(address) => void saveConfig({ ai: { local: { address } } })} hint="A llama-server or Ollama on this computer." />
          <Field
            label="Model file"
            value={ai.local.model}
            onSave={(model) => void saveConfig({ ai: { local: { model } } })}
            hint="Empty means the first model the server lists."
          />
          <div class="row">
            <Button icon={FlaskConical} small onClick={() => void run()} disabled={testing}>
              {testing ? 'Testing…' : 'Test'}
            </Button>
            {test && (
              <span class={test.ok ? 'ok-text' : 'error-text'} role="status">
                {test.ok ? <Check size={14} aria-hidden="true" /> : <X size={14} aria-hidden="true" />} {test.message}
              </span>
            )}
          </div>
        </div>
      )}
      {ai.engine === 'remote' && (
        <div class="fields">
          <Field label="Address" value={ai.remote.address} placeholder="https://…/v1" onSave={(address) => void saveConfig({ ai: { remote: { address } } })} />
          <Field label="Model" value={ai.remote.model} onSave={(model) => void saveConfig({ ai: { remote: { model } } })} />
          <Field
            label="Environment variable with the key"
            value={ai.remote.keyEnv}
            onSave={(keyEnv) => void saveConfig({ ai: { remote: { keyEnv } } })}
            hint="Skeinwise reads the key from this variable when it runs. The key itself is never saved."
          />
        </div>
      )}
      {ai.engine === 'none' && <Note>Search, the brain and every view work without AI. Organising uses plain text rules only.</Note>}
    </>
  );
}

/** Live capture's settings: the folders it follows besides agent histories and Downloads, and how it organises. */
function LiveSettings({ config }: { config: Config }) {
  const { live } = config;
  const [path, setPath] = useState('');
  const [owner, setOwner] = useState('');
  const folders = live.folders;
  const add = () => {
    const p = path.trim();
    if (!p) return;
    const folder = owner.trim() ? { path: p, owner: owner.trim() } : { path: p };
    void saveConfig({ live: { folders: [...folders, folder] } }).then((ok) => {
      if (ok) {
        setPath('');
        setOwner('');
      }
    });
  };
  return (
    <>
      <h4>Live capture</h4>
      <Switch label="Organise what Live capture brings in" checked={live.organise} onChange={(organise) => void saveConfig({ live: { organise } })} />
      {config.ai.engine === 'remote' && (
        <Switch label="Let it use the outside model, within the usage cap" checked={live.remote} onChange={(remote) => void saveConfig({ live: { remote } })} />
      )}
      <p class="field-label">Note folders it follows</p>
      {folders.length ? (
        <ul class="live-folders">
          {folders.map((f, i) => (
            <li key={f.path}>
              <span class="grow">
                {f.path}
                {f.owner && <span class="soft"> · {f.owner}’s words</span>}
              </span>
              <Button
                small
                kind="quiet"
                aria-label={`Stop following ${f.path}`}
                onClick={() => void saveConfig({ live: { folders: folders.filter((_, j) => j !== i) } })}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="soft small">None yet. Claude Code and Codex history and Downloads are followed wherever they exist.</p>
      )}
      <form
        class="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input class="grow" value={path} placeholder="/Users/you/Notes" spellcheck={false} aria-label="Folder to follow" onInput={(e) => setPath((e.currentTarget as HTMLInputElement).value)} />
        <input value={owner} placeholder="Whose words (you)" aria-label="Whose words the folder holds" onInput={(e) => setOwner((e.currentTarget as HTMLInputElement).value)} />
        <Button small type="submit" disabled={!path.trim()}>
          Add folder
        </Button>
      </form>
    </>
  );
}

function Appearance({ config }: { config: Config }) {
  return (
    <>
      <h4>Theme</h4>
      <div class="theme-grid" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => (
          <button
            key={t.key}
            type="button"
            role="radio"
            aria-checked={config.appearance.theme === t.key}
            class={`theme-card${config.appearance.theme === t.key ? ' on' : ''}`}
            style={{ background: t.ground, color: t.ink, borderColor: config.appearance.theme === t.key ? t.accent : t.line }}
            onClick={() => setTheme(t.key)}
            title={`Text contrast ${contrast(t.ink, t.ground).toFixed(1)} to 1`}
          >
            <span class="theme-swatch" style={{ background: t.panel, borderColor: t.line }}>
              <span style={{ background: t.accent }} />
              <span style={{ background: t.inkSoft }} />
            </span>
            <span>{t.name}</span>
            <span class="theme-kind" style={{ color: t.inkSoft }}>
              {t.light ? 'Light' : 'Dark'}
            </span>
          </button>
        ))}
      </div>
      <h4>Palette for the points</h4>
      <div class="palette-list" role="radiogroup" aria-label="Palette">
        {PALETTES.map((p) => {
          const t = THEMES.find((x) => x.key === config.appearance.theme) ?? THEMES[0]!;
          return (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={config.appearance.palette === p.key}
              class={`palette-row${config.appearance.palette === p.key ? ' on' : ''}`}
              onClick={() => void saveConfig({ appearance: { palette: p.key } })}
            >
              <span class="palette-dots" aria-hidden="true">
                {pointColors(p, t)
                  .slice(0, 8)
                  .map((c, i) => (
                    <span key={i} style={{ background: c }} />
                  ))}
              </span>
              <span>{p.name}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function Settings() {
  const open = useApp((s) => s.settingsOpen);
  if (!open) return null;
  return <Sheet />;
}

function Sheet() {
  const config = useApp((s) => s.config);
  const compact = useApp((s) => s.compact);
  const box = useFocusTrap(true);
  const close = () => setState({ settingsOpen: false });
  const [backingUp, setBackingUp] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!config) return null;

  const backup = async () => {
    setBackingUp(true);
    try {
      const r = await api.post<{ file: string; bytes: number }>('backup');
      toast(`Saved a ${fmtBytes(r.bytes)} backup to ${r.file}`, { tone: 'ok' });
    } catch (error) {
      toast(`No backup made: ${message(error)}`, { tone: 'error' });
    } finally {
      setBackingUp(false);
    }
  };

  return (
    <div class="overlay modal-open" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={box}>
        <header class="settings-head">
          <h2 id="settings-title">Settings</h2>
          <Button icon={X} kind="quiet" aria-label="Close settings" title="Close (Esc)" onClick={close} />
        </header>
        <div class="settings-body">
          {!compact && (
            <nav class="settings-nav" aria-label="Settings groups">
              {GROUPS.map((g) => (
                <a key={g} href={`#${slug(g)}`} onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(slug(g))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                }}>
                  {g}
                </a>
              ))}
            </nav>
          )}
          <div class="settings-groups">
            <Group title="Sync">
              <Field label="Folder" value={config.sync.folder} placeholder="A folder your sync app shares" onSave={(folder) => void saveConfig({ sync: { folder } })} />
              <Note>An encrypted copy in this folder, with a passphrase and recovery words. {LATER_NOTE}</Note>
            </Group>
            <Group title="AI agents">
              <Agents config={config} />
            </Group>
            <Group title="AI model">
              <Model config={config} />
              <LiveSettings config={config} />
            </Group>
            <Group title="Usage cap">
              <Field
                label="Tokens a month for an outside model"
                type="number"
                value={String(config.usageCap.monthlyTokens)}
                onSave={(v) => {
                  const n = Math.round(Number(v));
                  if (Number.isFinite(n) && n >= 0) void saveConfig({ usageCap: { monthlyTokens: n } });
                  else toast('The cap must be a whole number of tokens.', { tone: 'error' });
                }}
                hint={`Now ${fmtNum(config.usageCap.monthlyTokens)}. At the cap, runs wait for the next month.`}
              />
            </Group>
            <Group title="Proof of date">
              <Switch label="Prove when each entry was written" checked={config.proofOfDate} onChange={(proofOfDate) => void saveConfig({ proofOfDate })} />
              <Note>{LATER_NOTE}</Note>
            </Group>
            <Group title="Backup">
              <div class="row">
                <Button icon={Archive} onClick={() => void backup()} disabled={backingUp}>
                  {backingUp ? 'Backing up…' : 'Back up now'}
                </Button>
              </div>
              <Switch label="Back up every day" checked={config.backup.daily} onChange={(daily) => void saveConfig({ backup: { daily } })} />
              <Note>A backup is a zip of the record in the backups folder of your Skeinwise home. Daily backups: {LATER_NOTE.toLowerCase()}</Note>
            </Group>
            <Group title="Exclusions">
              <label class="field">
                <span class="field-label">Rules, one a line</span>
                <textarea
                  rows={4}
                  spellcheck={false}
                  placeholder={'source:Claude Code\nfolder:Private\n*password*'}
                  value={config.exclusions.rules.join('\n')}
                  onBlur={(e) => {
                    const rules = (e.currentTarget as HTMLTextAreaElement).value
                      .split('\n')
                      .map((r) => r.trim())
                      .filter(Boolean);
                    if (rules.join('\n') !== config.exclusions.rules.join('\n')) void saveConfig({ exclusions: { rules } });
                  }}
                />
                <span class="field-hint">By source, folder or a pattern.</span>
              </label>
              <Note>The organiser doesn’t apply these rules yet; they are kept. To leave a whole source out now, use skeinwise exclude.</Note>
              <Switch label="Redact names and numbers before an outside model" checked={config.exclusions.redact} onChange={(redact) => void saveConfig({ exclusions: { redact } })} />
            </Group>
            <Group title="Appearance">
              <Appearance config={config} />
            </Group>
          </div>
        </div>
      </div>
    </div>
  );
}
