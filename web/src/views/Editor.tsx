// The notes editor: plain Markdown beside a preview. Typing [[ suggests note names; ⌘S saves.

import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { Save, X } from 'lucide-preact';
import { changed, closeEditor, loadRecord, message, openEntry, toast, wordNotice } from '../actions.ts';
import { api } from '../api.ts';
import { openLink, renderMarkdown } from '../markdown.ts';
import { useApp } from '../store.ts';
import type { EntryDetail, SavedEntry } from '../types.ts';
import { Button, MOD, TabList } from '../ui/common.tsx';
import { tabPanel } from '../ui/tabs.ts';

export function Editor({ id, title: initialTitle }: { id: number | null; title: string }) {
  const compact = useApp((s) => s.compact);
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState('');
  const [saved, setSaved] = useState<string | null>(id === null ? '' : null);
  const [ownFile, setOwnFile] = useState(true);
  const [notes, setNotes] = useState<{ id: number; title: string }[]>([]);
  const [suggest, setSuggest] = useState<{ start: number; typed: string; at: number } | null>(null);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const tabsId = useId();
  const [confirmClose, setConfirmClose] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.get<{ id: number; title: string }[]>('notes').then(setNotes, () => setNotes([]));
    if (id === null) {
      area.current?.focus();
      return;
    }
    api.get<EntryDetail & { ownFile: boolean }>(`entries/${id}`).then(
      (d) => {
        setBody(d.entry.body);
        setSaved(d.entry.body);
        setTitle(d.entry.title ?? initialTitle);
        setOwnFile(d.ownFile);
        requestAnimationFrame(() => area.current?.focus());
      },
      (e: unknown) => toast(`Couldn't open the note: ${message(e)}`, { tone: 'error' }),
    );
  }, [id]);

  const dirty = saved !== null && body !== saved;
  const matches = useMemo(() => {
    if (!suggest) return [];
    const q = suggest.typed.toLowerCase();
    return notes.filter((n) => n.title.toLowerCase().includes(q)).slice(0, 8);
  }, [suggest, notes]);

  const save = async () => {
    if (id === null && !title.trim()) {
      toast('Give the note a title first.');
      return;
    }
    try {
      if (id === null) {
        const res = await api.post<{ id: number }>('notes', { title: title.trim(), body });
        await loadRecord();
        toast(`Saved “${title.trim()}” in your notes folder.`, { tone: 'ok' });
        closeEditor();
        openEntry(res.id);
        return;
      }
      if (!body.trim()) {
        toast('A note can’t be saved empty.');
        return;
      }
      const before = saved ?? '';
      const res = await api.put<SavedEntry>(`entries/${id}`, { body });
      setSaved(body);
      await loadRecord();
      changed(
        `Saved as version ${res.version.version}${res.wroteFile ? ', and the file too' : ''}.`,
        `Put “${title || 'the note'}” back as it was`,
        async () => {
          wordNotice(await api.put<SavedEntry>(`entries/${id}`, { body: before }));
          await loadRecord();
        },
      );
      wordNotice(res);
    } catch (error) {
      toast(`Not saved: ${message(error)}`, { tone: 'error' });
    }
  };

  const pick = (name: string) => {
    if (!suggest || !area.current) return;
    const el = area.current;
    const caret = el.selectionStart;
    const next = `${body.slice(0, suggest.start)}${name}]]${body.slice(caret).replace(/^\]\]/, '')}`;
    setBody(next);
    setSuggest(null);
    const at = suggest.start + name.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
      return;
    }
    if (suggest && matches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = matches.length;
        setSuggest({ ...suggest, at: (suggest.at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(matches[suggest.at]?.title ?? matches[0]!.title);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (suggest) setSuggest(null);
      else tryClose();
    }
  };

  const tryClose = () => {
    if (dirty && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    closeEditor();
  };

  const onInput = (e: Event) => {
    const el = e.currentTarget as HTMLTextAreaElement;
    setBody(el.value);
    setConfirmClose(false);
    const open = openLink(el.value, el.selectionStart);
    setSuggest(open ? { ...open, at: 0 } : null);
  };

  return (
    <section class="editor" role="dialog" aria-label={id === null ? 'New note' : `Edit ${title}`} onKeyDown={onKeyDown}>
      <header class="editor-head">
        {id === null ? (
          <input class="editor-title" placeholder="Title" value={title} aria-label="Title" onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
        ) : (
          <h2 class="editor-title">{title || 'Untitled'}</h2>
        )}
        <span class="soft small">{dirty ? 'Not saved' : saved === null ? 'Opening…' : 'Saved'}</span>
        {confirmClose && (
          <span class="confirm" role="alert">
            Close without saving?
            <button type="button" class="link" onClick={closeEditor}>
              Close
            </button>
            <button type="button" class="link" onClick={() => setConfirmClose(false)}>
              Keep editing
            </button>
          </span>
        )}
        <Button icon={Save} kind="primary" small onClick={() => void save()} title={`Save (${MOD}S)`}>
          Save
        </Button>
        <Button icon={X} kind="quiet" small aria-label="Close the editor" onClick={tryClose} />
      </header>
      {!ownFile && id !== null && (
        <p class="band">Saving adds a new version in the record. The original file stays as it was.</p>
      )}
      {compact && (
        <TabList
          id={tabsId}
          label="Editor"
          tabs={[
            ['write', 'Write'],
            ['preview', 'Preview'],
          ]}
          value={tab}
          onChange={setTab}
        />
      )}
      <div class="editor-panes" {...(compact ? tabPanel(tabsId, tab) : {})}>
        {(!compact || tab === 'write') && (
          <div class="editor-write">
            <textarea
              ref={area}
              value={body}
              onInput={onInput}
              onBlur={() => setTimeout(() => setSuggest(null), 150)}
              spellcheck
              aria-label="Markdown"
              placeholder="Write in Markdown. Type [[ to link a note."
            />
            {suggest && matches.length > 0 && (
              <ul class="suggest" role="listbox" aria-label="Notes">
                {matches.map((n, i) => (
                  <li key={n.id} role="option" aria-selected={i === suggest.at}>
                    <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(n.title)}>
                      {n.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {(!compact || tab === 'preview') && (
          <div class="editor-preview prose" aria-label="Preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) || '<p class="soft">The preview shows here.</p>' }} />
        )}
      </div>
    </section>
  );
}
