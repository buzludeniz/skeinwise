// Your notes in the record folder: Markdown files under <home>/notes, one daily note per day in notes/daily. Writing
// one reads the notes folder back into the record as your own words, so a change made here or in any editor becomes a
// version of the same entry. An agent writing through the memory server reads your edits in first, so they stay
// yours, and then saves only its own file as a version under its name (`agent:<name>`). Each such save is a run of its
// own (task 'note'), so `skeinwise undo <run>` takes it back, file and all.
//
// A note file is written only inside the notes folder and never through a link (L8): its folder must resolve inside
// notes/, and the file itself is opened with O_NOFOLLOW, so a link planted at a note's name, or a linked notes/daily,
// can't send a write to a file elsewhere.

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { UsageError } from './errors.ts';
import { pathInside, readImports } from './importers/detect.ts';
import { parseFrontMatter } from './importers/notes.ts';
import { currentMark, finishRun, startRun } from './organiser/runs.ts';
import { inTransaction } from './store/db.ts';
import type { Entry, Store, Version } from './store/store.ts';

export interface NoteWrite {
  path: string;
  entryId: number;
  /** True when the file was new. */
  created: boolean;
  /** An agent's save: the run it is, which `skeinwise undo <run>` takes back. */
  runId?: number;
}

/** The editor an agent's versions carry. Saves made before runs named the agent alone. */
export function agentEditor(agent: string): string {
  return `agent:${agent}`;
}

/** The agent's own name in an editor agentEditor made; any other editor as it is. */
export function editorName(editor: string): string {
  return editor.startsWith('agent:') ? editor.slice('agent:'.length) : editor;
}

export function notesDir(home: string): string {
  return resolve(home, 'notes');
}

/** O_NOFOLLOW where the system has it; on Windows, where it doesn't, openNoFollow's lstat check stands in for it. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

function outside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Whether anything is at the path, a link included (existsSync follows a link and calls a dangling one absent). */
function present(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

const LINK = (rel: string) => `${rel} is a link, and Skeinwise doesn't write through links in the notes folder. Nothing was written.`;

/** A note file's full path, once it is checked to lie in the notes folder with no link on the way. Its folder exists. */
function notePath(dir: string, path: string): string {
  const full = resolve(path);
  const rel = relative(dir, full);
  if (!rel || outside(rel)) throw new Error(`${path} is not in the notes folder ${dir}. Nothing was written.`);
  if (outside(relative(realpathSync(dir), realpathSync(dirname(full))))) {
    throw new Error(`${rel} leads out of the notes folder through a link. Nothing was written.`);
  }
  if (lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(LINK(rel));
  return full;
}

/** Opens a file without following a link at its last step; a link there is refused in plain words. */
function openNoFollow(full: string, flags: number): number {
  if (!NO_FOLLOW && lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(LINK(full));
  try {
    return openSync(full, flags | NO_FOLLOW, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(LINK(full));
    throw err;
  }
}

function withFile<T>(full: string, flags: number, fn: (fd: number) => T): T {
  const fd = openNoFollow(full, flags);
  try {
    return fn(fd);
  } finally {
    closeSync(fd);
  }
}

const { O_APPEND, O_CREAT, O_EXCL, O_RDONLY, O_WRONLY } = constants;

/** Writes a new note file; refuses when anything, a link included, is already at its name. */
function createNoteFile(dir: string, path: string, text: string): void {
  withFile(notePath(dir, path), O_WRONLY | O_CREAT | O_EXCL, (fd) => writeFileSync(fd, text));
}

function readNoteFile(path: string): string {
  return withFile(resolve(path), O_RDONLY, (fd) => readFileSync(fd, 'utf8'));
}

/** The local calendar day, as YYYY-MM-DD. */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Adds a line to today's daily note, starting the note when it is the first line of the day. With an agent, the line
 * starts with the agent's name and the save is a version under that name.
 */
export function appendDailyNote(store: Store, home: string, text: string, now: Date, agent?: string): NoteWrite {
  const line = text.trim();
  if (!line) throw new UsageError('Give the text to add, for example: skeinwise note "Fed the starter at 18:00"');
  const dir = notesDir(home);
  const day = localDay(now);
  const path = join(dir, 'daily', `${day}.md`);
  const item = `- ${agent ? `${agent}: ` : ''}${line.replace(/\r?\n/g, '\n  ')}\n`;
  if (agent) readNotes(store, home);
  const created = !present(path);
  mkdirSync(dirname(path), { recursive: true });
  let before: Buffer | null = null;
  if (created) {
    createNoteFile(dir, path, `# ${day}\n\n${item}`);
  } else {
    const full = notePath(dir, path);
    before = fileBytes(full);
    const old = before.toString('utf8');
    withFile(full, O_WRONLY | O_APPEND, (fd) => writeFileSync(fd, old && !old.endsWith('\n') ? `\n${item}` : item));
  }
  if (!agent) return { path, created, entryId: readBack(store, dir, path) };
  return { path, created, ...saveOrPutBack(store, dir, path, agent, { speaker: false, created, now }, before) };
}

/** A file name from a title: lower case letters and digits joined by dashes. */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

/** Starts a note with a title. Refuses when a note of that name is already there. */
export function newNote(store: Store, home: string, title: string, now: Date): NoteWrite {
  const name = title.trim().replace(/\s+/g, ' ');
  if (!name) throw new UsageError('Give the note a title, for example: skeinwise new-note "Garden plan"');
  const slug = slugify(name);
  if (!slug) throw new UsageError(`"${name}" has no letters or digits to name a file after.`);
  const dir = notesDir(home);
  const path = join(dir, `${slug}.md`);
  if (present(path)) throw new UsageError(`A note already exists at ${path}. Open it in an editor, or pick another title.`);
  mkdirSync(dir, { recursive: true });
  createNoteFile(dir, path, `---\ncreated: ${now.toISOString()}\n---\n\n# ${name}\n`);
  return { path, created: true, entryId: readBack(store, dir, path) };
}

/**
 * Writes a note as an agent: a new note whose front matter names the agent, or new text for a note the same agent
 * started and was the last to change. It never touches your notes or another agent's. The entry's speaker is the
 * agent, so the organiser doesn't read the note as your words.
 */
export function writeAgentNote(store: Store, home: string, agent: string, title: string, body: string, now: Date): NoteWrite {
  const name = title.trim().replace(/\s+/g, ' ');
  const text = body.trim();
  if (!name) throw new UsageError('Give the note a title.');
  if (!text) throw new UsageError('Give the note some text.');
  const slug = slugify(name);
  if (!slug) throw new UsageError(`"${name}" has no letters or digits to name a file after.`);
  const dir = notesDir(home);
  const path = join(dir, `${slug}.md`);
  const content = `# ${name}\n\n${text}\n`;
  readNotes(store, home);
  if (!present(path)) {
    mkdirSync(dir, { recursive: true });
    createNoteFile(dir, path, `---\ncreated: ${now.toISOString()}\nagent: ${agent}\n---\n\n${content}`);
    // Live capture may read the new file first and file it as yours; the version and the front matter still name the
    // agent, and the importer reading `agent:` would close that gap.
    return { path, created: true, ...saveOrPutBack(store, dir, path, agent, { speaker: true, created: true, now }, null) };
  }
  const owner = parseFrontMatter(readNoteFile(notePath(dir, path))).meta.agent;
  const file = pathInside(dir, path);
  if (typeof owner !== 'string' || !owner) {
    throw new UsageError(`${file} is your note, and agents can't change your notes. Pick another title, or add a line to today's note.`);
  }
  const same = (name: string) => name.toLowerCase() === agent.toLowerCase(); // agent names match as allowAgent matches them
  if (!same(owner)) throw new UsageError(`${file} was written by ${owner}, and only ${owner} can change it. Pick another title.`);
  const history = store.history(entryOf(store, dir, path));
  const last = history.at(-1);
  // An agent name has no colon (access.ts), so `agent:<name>` and an older save's plain name can't be confused.
  const byAgent = (editor: string) => same(editorName(editor));
  // A later version that holds text this agent wrote (an undo of its own change puts its earlier text back, as yours)
  // has no one else's words in it, so the agent may change the note again.
  const itsText = (v: Version) => history.some((w) => byAgent(w.editor) && w.contentHash === v.contentHash);
  if (last && !byAgent(last.editor) && !itsText(last)) {
    throw new UsageError(`${file} was changed by ${last.editor} after ${agent} wrote it, so it stays as it is. Pick another title.`);
  }
  const before = fileBytes(notePath(dir, path));
  rewriteNoteFile(path, content);
  return { path, created: false, ...saveOrPutBack(store, dir, path, agent, { speaker: false, created: false, now }, before) };
}

/**
 * Reads the record folder's notes into the record as your words, so an edit made in any editor becomes a version of
 * the same entry. Writing a note does this, and so do a run and a question before they read the record.
 */
export function readNotes(store: Store, home: string): void {
  const dir = notesDir(home);
  if (!existsSync(dir)) return;
  for (const batch of readImports(dir, { emptyOk: true })) if (batch.source.kind === 'notes') store.ingest(batch, 'you');
}

/** Reads the notes folder into the record, and returns the entry for one file in it. */
function readBack(store: Store, dir: string, path: string): number {
  for (const batch of readImports(dir)) if (batch.source.kind === 'notes') store.ingest(batch, 'you');
  return entryOf(store, dir, path);
}

/**
 * Reads one file of the notes folder into the record as an agent's save, which is a run of its own: task 'note', engine
 * 'agent', the agent's name as the model. Its version names the agent (`agent:<name>`) and carries the run's id. The
 * run records the file, whether the save made it, and the file's SHA-256, so undo removes only that file and only while
 * it holds what the run wrote. The run starts and finishes in the save's transaction, so it is never left running, and
 * it starts alongside an organiser run that is running. With `speaker`, a new entry is the agent's.
 */
function saveAsAgent(
  store: Store,
  dir: string,
  path: string,
  agent: string,
  { speaker, created, now, sha256 }: { speaker: boolean; created: boolean; now: Date; sha256: string },
): { entryId: number; runId: number } {
  const file = pathInside(dir, path);
  const batches = readImports(dir).filter((b) => b.source.kind === 'notes');
  const db = store.db;
  const at = now.toISOString();
  return inTransaction(db, () => {
    const runId = startRun(db, {
      task: 'note',
      engine: 'agent',
      model: agent,
      scope: 'agent',
      mark: currentMark(db),
      detail: { file, created, sha256 },
      now: at,
      alongside: true,
    });
    for (const batch of batches) {
      const entries = (batch.entries ?? []).filter((e) => e.externalId === file).map((e) => (speaker ? { ...e, speaker: agent } : e));
      store.ingest({ ...batch, threads: [], entries }, { editor: agentEditor(agent), runId });
    }
    const entryId = entryOf(store, dir, path);
    const saved = Number((db.prepare('SELECT COUNT(*) AS n FROM versions WHERE run_id = ?').get(runId) as { n: number }).n);
    finishRun(db, runId, {
      counts: { versions: saved },
      message: saved ? `${agent} ${created ? 'started' : 'changed'} note #${entryId}.` : `${agent} saved note #${entryId} unchanged.`,
      tokensIn: 0,
      tokensOut: 0,
      now: at,
    });
    return { entryId, runId };
  });
}

/**
 * Saves the file an agent just wrote as its run (saveAsAgent). When the save fails (the record busy past its wait,
 * say), the file goes back to what it held before, `before`, or away if the agent made it: left as the agent wrote it,
 * the next read would file the agent's text as yours. A file changed again in the meantime is someone else's text and
 * stays.
 */
function saveOrPutBack(
  store: Store,
  dir: string,
  path: string,
  agent: string,
  save: { speaker: boolean; created: boolean; now: Date },
  before: Buffer | null,
): { entryId: number; runId: number } {
  const sha256 = fileSha256(path);
  try {
    return saveAsAgent(store, dir, path, agent, { ...save, sha256 });
  } catch (error) {
    const file = pathInside(dir, path);
    try {
      if (present(path) && fileSha256(path) === sha256) {
        if (before === null) unlinkSync(notePath(dir, path));
        else withFile(notePath(dir, path), O_WRONLY, (fd) => (ftruncateSync(fd, 0), writeFileSync(fd, before)));
      }
    } catch (cause) {
      throw new Error(`${file} wasn't saved (${(error as Error).message}), and it couldn't be put back as it was: ${(cause as Error).message}`);
    }
    throw error;
  }
}

/** A note file's bytes, read without following a link. */
function fileBytes(path: string): Buffer {
  return withFile(resolve(path), O_RDONLY, (fd) => readFileSync(fd));
}

/** The SHA-256 of a note file's bytes, read without following a link. */
function fileSha256(path: string): string {
  return createHash('sha256').update(fileBytes(path)).digest('hex');
}

/**
 * The file an agent's run started, checked before undo removes it: the path the run recorded, in the notes folder with
 * no link on the way or at the file, and still holding exactly what the run wrote. Null when the file is gone. Anything
 * else is refused in plain words, before anything is removed.
 */
export function startedNoteFile(home: string, file: string, sha256: string, runId: number): string | null {
  const dir = notesDir(home);
  const full = resolve(dir, file);
  const rel = relative(dir, full);
  if (!rel || outside(rel)) throw new UsageError(`Run ${runId} recorded ${file}, which isn't in the notes folder. Nothing was removed.`);
  const stat = lstatSync(full, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new UsageError(`${rel} is now a link or not a file, so it isn't what run ${runId} wrote. Nothing was removed.`);
  }
  if (outside(relative(realpathSync(dir), realpathSync(dirname(full))))) {
    throw new UsageError(`${rel} leads out of the notes folder through a link. Nothing was removed.`);
  }
  if (fileSha256(full) !== sha256) {
    throw new UsageError(`${rel} changed after run ${runId} wrote it, so it stays. Nothing was removed.`);
  }
  return full;
}

/** Removes a file startedNoteFile checked. unlink removes a link itself, never what it points at. */
export function removeNoteFile(full: string): void {
  unlinkSync(full);
}

function entryOf(store: Store, dir: string, path: string): number {
  const row = store.db
    .prepare(
      `SELECT e.id FROM entries e JOIN sources s ON s.id = e.source_id
       WHERE s.kind = 'notes' AND s.location = ? AND e.external_id = ?`,
    )
    .get(dir, pathInside(dir, path)) as { id: number } | undefined;
  if (!row) throw new Error(`${path} was written but did not reach the record.`);
  return row.id;
}

/**
 * The file behind an entry, when it is a note in the record folder's notes; null for anything else, and for a path
 * that would lead out of the notes folder, by `..` or through a linked folder.
 */
export function homeNoteFile(store: Store, home: string, entry: Entry): string | null {
  if (entry.sourceKind !== 'notes') return null;
  const row = store.db.prepare('SELECT location FROM sources WHERE id = ?').get(entry.sourceId) as { location: string } | undefined;
  const dir = notesDir(home);
  if (!row?.location || resolve(row.location) !== dir) return null;
  const file = resolve(dir, entry.externalId);
  if (!relative(dir, file) || outside(relative(dir, file))) return null;
  if (existsSync(dir) && existsSync(dirname(file)) && outside(relative(realpathSync(dir), realpathSync(dirname(file))))) return null;
  return file;
}

/**
 * The path in the record folder of a note file that is a Word document, or null for any other file. Skeinwise only
 * reads a Word document, so whatever changes the note's text in the record leaves the file as it is and tells the
 * person: rewriteNoteFile would write Markdown over it and ruin it.
 */
export function wordNoteFile(home: string, file: string): string | null {
  return extname(file).toLowerCase() === '.docx' ? pathInside(home, file) : null;
}

/**
 * Replaces a note file's text below its front matter, which stays as it was. The path comes from homeNoteFile or
 * notePath, which keep it in the notes folder; a link at the file itself is refused here, and so is a Word document
 * (wordNoteFile), which this would ruin.
 */
export function rewriteNoteFile(path: string, body: string): void {
  if (extname(path).toLowerCase() === '.docx') throw new Error(`${path} is a Word document, which Skeinwise doesn't write. Nothing was saved.`);
  if (!present(path)) throw new Error(`The note file ${path} is gone, so it can't be updated. Nothing was saved.`);
  const front = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(readNoteFile(path))?.[0];
  // Truncated after the open, not with O_TRUNC: Windows refuses O_TRUNC without O_CREAT (EINVAL).
  withFile(resolve(path), O_WRONLY, (fd) => {
    ftruncateSync(fd, 0);
    writeFileSync(fd, `${front ? `${front}\n` : ''}${body.trim()}\n`);
  });
}
