// The Add panel: files, folders and drops; the sources found on this computer; a new note; and the guides for
// getting an export, while Skeinwise watches Downloads for the file.

import { useEffect, useState } from 'preact/hooks';
import { ArrowLeft, CircleCheck, Download, FilePlus2, FileUp, FolderUp } from 'lucide-preact';
import { closePanel, loadRecord, message, openEditor, openPanel, toast } from '../actions.ts';
import { api } from '../api.ts';
import { growOnNextLoad } from '../brain/useBrain.ts';
import { bringInFiles, droppedFiles, pickFiles } from '../files.ts';
import { fmtRange, plural } from '../format.ts';
import type { Found, ImportResult, Preview } from '../types.ts';
import { EXPORTS } from '../ui/AppMenu.tsx';
import { Button, SidePanel } from '../ui/common.tsx';
import { importSummary } from '../upload.ts';

type Guide = 'chatgpt' | 'claude' | 'gemini';
type FoundRow = Found & { decision: 'in' | 'out' | 'later' | null };

/** Our own short steps for asking each service for an export. */
const GUIDES: Record<Guide, { name: string; steps: string[] }> = {
  chatgpt: {
    name: 'ChatGPT',
    steps: [
      'Open ChatGPT in a browser and sign in.',
      'Open Settings, then the data controls.',
      'Choose to export your data, and confirm.',
      'A link comes by email, often within the hour. Download the zip it points to.',
      'Leave the zip in Downloads. It shows up here when it lands.',
    ],
  },
  claude: {
    name: 'Claude',
    steps: [
      'Open Claude in a browser and sign in.',
      'Open Settings, then the privacy section.',
      'Choose to export your data.',
      'A link comes by email. Download the zip it points to.',
      'Leave the zip in Downloads. It shows up here when it lands.',
    ],
  },
  gemini: {
    name: 'Gemini',
    steps: [
      'Open Google Takeout and sign in.',
      'Deselect everything, then pick My Activity.',
      'In its options, keep only Gemini Apps.',
      'Create the export. A link comes by email when it is ready.',
      'Download the zip and leave it in Downloads. It shows up here when it lands.',
    ],
  },
};

export async function bringIn(path: string, owner: string, label: string): Promise<ImportResult[]> {
  toast(`Bringing in ${label}…`);
  const results = await api.post<ImportResult[]>('import', { path, owner });
  growOnNextLoad();
  await loadRecord();
  toast(importSummary(results), { tone: 'ok' });
  return results;
}

function FoundCard({ found, onDone }: { found: FoundRow; onDone: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [owner, setOwner] = useState('you');
  const [busy, setBusy] = useState(false);
  const look = async () => {
    try {
      setPreview(await api.post<Preview>('found/preview', { path: found.path }));
    } catch (error) {
      toast(`Couldn't read it: ${message(error)}`, { tone: 'error' });
    }
  };
  const go = async () => {
    setBusy(true);
    try {
      await bringIn(found.path, owner.trim() || 'you', found.label);
      onDone();
    } catch (error) {
      toast(`Not brought in: ${message(error)}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li class="card found-card">
      <div class="found-head">
        <strong>{found.label}</strong>
        {found.inRecord && (
          <span class="tag tag-ok">
            <CircleCheck size={12} aria-hidden="true" /> In the record
          </span>
        )}
      </div>
      <p class="soft small">
        {found.detail}
        {preview && ` · ${plural(preview.entries, 'entry', 'entries')}${preview.first ? `, ${fmtRange(preview.first, preview.last)}` : ''}`}
      </p>
      <p class="path" title={found.path}>
        {found.path}
      </p>
      {found.asksOwner && (
        <label class="field field-inline">
          <span class="field-label">Whose words?</span>
          <select value={owner === 'you' ? 'you' : 'other'} onChange={(e) => setOwner((e.currentTarget as HTMLSelectElement).value === 'you' ? 'you' : '')}>
            <option value="you">Mine</option>
            <option value="other">Someone else’s</option>
          </select>
          {owner !== 'you' && (
            <input placeholder="Their name" value={owner} aria-label="Their name" onInput={(e) => setOwner((e.currentTarget as HTMLInputElement).value)} />
          )}
        </label>
      )}
      <div class="row">
        <Button kind="primary" small onClick={() => void go()} disabled={busy}>
          {busy ? 'Bringing it in…' : found.inRecord ? 'Bring in what’s new' : 'Bring it in'}
        </Button>
        {!preview && (
          <Button small kind="quiet" onClick={() => void look()}>
            How much is there?
          </Button>
        )}
      </div>
    </li>
  );
}

function GuideView({ guide, found }: { guide: Guide; found: FoundRow[] }) {
  const g = GUIDES[guide];
  const landed = found.filter((f) => f.kind === guide && !f.inRecord);
  return (
    <div class="guide">
      <button type="button" class="link back" onClick={() => openPanel({ kind: 'add' })}>
        <ArrowLeft size={14} aria-hidden="true" /> All the ways to add
      </button>
      <h3>Get your {g.name} export</h3>
      <ol class="steps">
        {g.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p class="soft small">Menu names change now and then. If one is missing, look for an export or a data option.</p>
      {landed.length ? (
        <ul class="found-list">
          {landed.map((f) => (
            <FoundCard key={f.id} found={f} onDone={() => openPanel({ kind: 'add' })} />
          ))}
        </ul>
      ) : (
        <p class="watching" role="status">
          <span class="pulse" aria-hidden="true" /> Watching Downloads for the {g.name} zip…
        </p>
      )}
    </div>
  );
}

export function AddPanel({ guide }: { guide?: Guide }) {
  const [found, setFound] = useState<FoundRow[] | null>(null);
  const [over, setOver] = useState(false);

  const refresh = () => api.get<FoundRow[]>('found').then(setFound, () => setFound([]));
  useEffect(() => {
    void refresh();
    if (!guide) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [guide]);

  const fresh = found?.filter((f) => !f.inRecord && f.decision !== 'out') ?? [];
  const known = found?.filter((f) => f.inRecord) ?? [];

  return (
    <SidePanel title={guide ? `Add from ${GUIDES[guide].name}` : 'Add'} label="Add" onClose={closePanel}>
      {guide ? (
        <GuideView guide={guide} found={found ?? []} />
      ) : (
        <>
          <div
            class={`drop${over ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              if (e.dataTransfer) void droppedFiles(e.dataTransfer).then((files) => bringInFiles(files));
            }}
          >
            <p>Drop an export zip, Markdown notes or a folder here.</p>
            <div class="row wrap">
              <Button icon={FileUp} onClick={() => pickFiles()}>
                Add files
              </Button>
              <Button icon={FolderUp} onClick={() => pickFiles(true)}>
                Add a folder
              </Button>
              <Button icon={FilePlus2} onClick={() => openEditor(null)}>
                New note
              </Button>
            </div>
            <p class="soft small">The files are copied into your record. The originals stay as they are.</p>
          </div>

          <section class="reader-section">
            <h3>Found on this computer</h3>
            {!found ? (
              <p class="soft">Looking…</p>
            ) : fresh.length ? (
              <ul class="found-list">
                {fresh.map((f) => (
                  <FoundCard key={f.id} found={f} onDone={() => void refresh()} />
                ))}
              </ul>
            ) : (
              <p class="soft">Nothing new. Agent history, exports in Downloads and note folders show up here.</p>
            )}
            {known.length > 0 && (
              <details>
                <summary>{plural(known.length, 'source')} already in the record</summary>
                <ul class="found-list">
                  {known.map((f) => (
                    <FoundCard key={f.id} found={f} onDone={() => void refresh()} />
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section class="reader-section">
            <h3>Get an export</h3>
            <div class="row wrap">
              {EXPORTS.map(([key, label]) => (
                <Button key={key} icon={Download} small onClick={() => openPanel({ kind: 'add', guide: key })}>
                  {label}
                </Button>
              ))}
            </div>
          </section>
        </>
      )}
    </SidePanel>
  );
}
