// A sync bundle: the whole record (a snapshot of record.db, the notes folder, config.json, app.json and the ledger)
// zipped and encrypted with the sync key. A bundle is always a full copy, never a difference, so any one of them is
// enough to rebuild the record on another computer.
//
// The file: "SKWSYNC" and a format byte, a 4-byte length, a small JSON header, then the AES-256-GCM ciphertext and
// its 16-byte tag. The header (key id, push number, writer, time, IV) is not secret but is authenticated: everything
// before the ciphertext is the cipher's associated data, so changing a single byte anywhere fails the check.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, relative } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { UsageError } from '../errors.ts';
import { notesDir } from '../notes.ts';
import { inTransaction, migrate, openDb, schemaVersion } from '../store/db.ts';
import { MIGRATIONS } from '../store/schema.ts';
import type { Store } from '../store/store.ts';

export const BUNDLE_FILE = 'skeinwise.bundle';

const MAGIC = Buffer.from('SKWSYNC\x01', 'latin1');

/** The record folder's own files that a bundle carries besides record.db and notes/. */
const SIDE_FILES = ['config.json', 'app.json', 'ledger.jsonl'] as const;

export interface BundleHeader {
  keyId: string;
  /** Push number: 1 for the bundle sync init writes, one more for each push after it. */
  seq: number;
  /** The computer that wrote it (a random id each computer keeps in its sync.json). */
  writer: string;
  createdAt: string;
  iv: string;
}

/** What bundle.json inside the zip says. */
export interface Manifest {
  format: 1;
  createdAt: string;
  /** The notes folder on the computer that wrote the bundle, so a join can point the notes source at its own. */
  notesDir: string;
  entries: number;
  schemaVersion: number;
}

/** A file written whole or not at all: the folder never holds half a bundle, even when a cloud drive syncs it mid-write. */
export function writeAtomic(path: string, data: Uint8Array | string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  // Safe on Windows too, where O_EXCL ('wx') follows a dangling link: the name is random and new, so no link waits there.
  const part = `${path}.${randomBytes(4).toString('hex')}.part`;
  try {
    writeFileSync(part, data, { mode, flag: 'wx' });
    renameSync(part, path);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}

// Writing a bundle

/** A consistent copy of record.db. serialize() reads it in one transaction; the copy is marked as an ordinary
 * (rollback-journal) database, since an image still marked WAL can't be opened from memory. */
export function snapshotDb(store: Store): Uint8Array {
  const bytes = store.db.serialize();
  bytes[18] = 1;
  bytes[19] = 1;
  return bytes;
}

function walk(dir: string, into: (file: string) => void): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, into);
    else if (e.isFile()) into(full);
  }
}

/** The files that make up the record, by their path inside the record folder. */
export function recordFiles(store: Store, home: string): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = { 'record.db': snapshotDb(store) };
  const notes = notesDir(home);
  if (existsSync(notes)) walk(notes, (file) => (files[relative(home, file).split(/[\\/]/).join('/')] = new Uint8Array(readFileSync(file))));
  for (const name of SIDE_FILES) {
    const file = join(home, name);
    if (statSync(file, { throwIfNoEntry: false })?.isFile()) files[name] = new Uint8Array(readFileSync(file));
  }
  return files;
}

function entryCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n);
}

/** Zips and encrypts the record. Returns the bundle's bytes and how many entries it holds. */
export function sealBundle(store: Store, home: string, key: Buffer, header: Omit<BundleHeader, 'iv' | 'createdAt'>): { bytes: Buffer; entries: number } {
  const createdAt = store.now();
  const entries = entryCount(store.db);
  const manifest: Manifest = { format: 1, createdAt, notesDir: notesDir(home), entries, schemaVersion: schemaVersion(store.db) };
  const files = recordFiles(store, home);
  files['bundle.json'] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const plain = zipSync(files, { level: 6 });
  const iv = randomBytes(12);
  const full: BundleHeader = { ...header, createdAt, iv: iv.toString('base64') };
  const head = headerBytes(full);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(head);
  const bytes = Buffer.concat([head, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { bytes, entries };
}

function headerBytes(header: BundleHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, len, json]);
}

// Reading a bundle

/** The header as written. Not yet checked: only openBundle proves it wasn't changed. */
export function readHeader(bytes: Buffer, where: string): { header: BundleHeader; headLength: number } {
  if (bytes.length < MAGIC.length + 4 || !bytes.subarray(0, 7).equals(MAGIC.subarray(0, 7))) throw new Error(`${where} is not a Skeinwise bundle.`);
  if (bytes[7] !== MAGIC[7]) throw new Error(`${where} was written by a newer Skeinwise (bundle format ${bytes[7]}). Update Skeinwise to open it.`);
  const len = bytes.readUInt32BE(MAGIC.length);
  const headLength = MAGIC.length + 4 + len;
  if (len > 4096 || bytes.length < headLength + 16) throw new Error(`${where} is damaged: it is cut short or its header is broken.`);
  let header: BundleHeader;
  try {
    header = JSON.parse(bytes.subarray(MAGIC.length + 4, headLength).toString('utf8')) as BundleHeader;
  } catch {
    throw new Error(`${where} is damaged: its header is not JSON.`);
  }
  if (typeof header?.keyId !== 'string' || !Number.isInteger(header.seq) || typeof header.iv !== 'string' || typeof header.createdAt !== 'string') {
    throw new Error(`${where} is damaged: its header is missing a part.`);
  }
  return { header, headLength };
}

/** A notes path from inside a bundle, as safe parts to join under the notes folder; null when it would step outside. */
function notePath(name: string): string[] | null {
  const parts = name.split(/[\\/]/);
  if (parts[0] !== 'notes' || parts.length < 2) return null;
  const rest = parts.slice(1);
  return rest.every((p) => p && p !== '.' && p !== '..' && !p.includes('\0')) ? rest : null;
}

export interface Opened {
  header: BundleHeader;
  manifest: Manifest;
  files: Record<string, Uint8Array>;
}

/** Checks and decrypts a bundle with the sync key. Throws, before anything is written anywhere, when it fails. */
export function openBundle(bytes: Buffer, key: Buffer, keyId: string, where: string): Opened {
  const { header, headLength } = readHeader(bytes, where);
  if (header.keyId !== keyId) throw new Error(`${where} belongs to a different sync than the key file next to it, so it can't be opened.`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAAD(bytes.subarray(0, headLength));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(bytes.subarray(headLength, bytes.length - 16)), decipher.final()]);
  } catch {
    throw new Error(`${where} fails its check: it was changed or damaged after it was written. Nothing was written.`);
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(plain);
  } catch (err) {
    throw new Error(`${where} opened, but the record inside it can't be unpacked: ${(err as Error).message}`);
  }
  for (const name of Object.keys(files)) {
    const known = name === 'record.db' || name === 'bundle.json' || (SIDE_FILES as readonly string[]).includes(name);
    if (!known && !notePath(name)) throw new Error(`${where} holds a file Skeinwise doesn't expect there: ${name}. Nothing was written.`);
  }
  if (!files['record.db'] || !files['bundle.json']) throw new Error(`${where} is missing the record or its manifest. Nothing was written.`);
  const manifest = JSON.parse(new TextDecoder().decode(files['bundle.json'])) as Manifest;
  if (manifest.format !== 1) throw new Error(`${where} was written by a newer Skeinwise (bundle contents format ${manifest.format}). Update Skeinwise to open it.`);
  return { header, manifest, files };
}

// Joining: making an empty record a copy of the bundle's

interface TableInfo {
  name: string;
  virtual: boolean;
  columns: string[];
}

/** The record's tables that hold data: ordinary and virtual (full-text) tables, not views, FTS internals or SQLite's own. */
function dataTables(db: DatabaseSync): TableInfo[] {
  const rows = db.prepare(`SELECT name, type FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'virtual') AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as {
    name: string;
    type: string;
  }[];
  return rows.map((r) => ({
    name: r.name,
    virtual: r.type === 'virtual',
    columns: (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(r.name) as { name: string }[]).map((c) => c.name),
  }));
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

function selectAll(t: TableInfo): string {
  return `SELECT ${t.virtual ? 'rowid, ' : ''}${t.columns.map(q).join(', ')} FROM ${q(t.name)}`;
}

/** The first thing under a folder that isn't itself a folder (a file, a link), or null when there are only folders. */
function firstNonFolder(dir: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const found = e.isDirectory() ? firstNonFolder(full) : full;
    if (found) return found;
  }
  return null;
}

/**
 * Why the record isn't empty, or null when it is: nothing in it but what a new record starts with (the built-in
 * schemas and Moods tags), no notes files, no ledger, and no sync set up.
 */
export function notEmpty(store: Store, home: string): string | null {
  const entries = entryCount(store.db);
  if (entries) return `it holds ${entries} entries`;
  const fresh = openDb(':memory:');
  try {
    for (const t of dataTables(store.db)) {
      const mine = (store.db.prepare(selectAll(t)).all() as object[]).map((r) => JSON.stringify(r)).sort();
      const blank = (fresh.prepare(selectAll(t)).all() as object[]).map((r) => JSON.stringify(r)).sort();
      if (mine.length !== blank.length || mine.some((r, i) => r !== blank[i])) return `its ${t.name} table has rows of its own`;
    }
  } finally {
    fresh.close();
  }
  const note = existsSync(notesDir(home)) ? firstNonFolder(notesDir(home)) : null;
  if (note) return `its notes folder has files (${note})`;
  // Settings (config.json, app.json) don't count: a join keeps this computer's. The ledger does.
  if (existsSync(join(home, 'ledger.jsonl'))) return 'it has a ledger.jsonl';
  return null;
}

/** Opens the bundle's record.db in memory and brings its schema up to this version's. */
function bundleDb(bytes: Uint8Array, where: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  try {
    db.deserialize(bytes);
    const version = schemaVersion(db);
    if (version > MIGRATIONS.length) {
      throw new UsageError(`${where} was written by a newer Skeinwise (record schema ${version}; this one knows ${MIGRATIONS.length}). Update Skeinwise, then join again. Nothing was written.`);
    }
    migrate(db);
    return db;
  } catch (err) {
    db.close();
    if (err instanceof UsageError) throw err;
    throw new Error(`The record inside ${where} can't be read: ${(err as Error).message}. Nothing was written.`);
  }
}

export interface Joined {
  entries: number;
  notes: number;
  /** Side files written; config.json and app.json are left alone when this computer already has them. */
  wrote: string[];
  kept: string[];
}

/**
 * Makes an empty record a copy of an opened bundle: every table's rows, the notes files and the side files. The
 * database part is one transaction. The caller has checked notEmpty() first.
 */
export function joinBundle(store: Store, home: string, opened: Opened, where: string): Joined {
  const snap = bundleDb(opened.files['record.db']!, where);
  const notes = notesDir(home);
  const tag = randomBytes(4).toString('hex');
  const staging = join(home, `.sync-notes-${tag}`);
  const old = join(home, `.sync-old-notes-${tag}`);
  const noteFiles = Object.entries(opened.files).filter(([name]) => name.startsWith('notes/'));
  let movedOld = false;
  let placed = false;
  try {
    // The notes go in place first, and come out again if the copy below fails. This computer's notes folder holds
    // no files (notEmpty() checked), only perhaps empty folders; it is set aside, and removed once the copy is in.
    for (const [name, data] of noteFiles) {
      const parts = notePath(name)!;
      mkdirSync(join(staging, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(staging, ...parts), data, { mode: 0o600 });
    }
    if (noteFiles.length) {
      if (existsSync(notes)) {
        renameSync(notes, old);
        movedOld = true;
      }
      renameSync(staging, notes);
      placed = true;
    }
    inTransaction(store.db, () => {
      store.db.exec('PRAGMA defer_foreign_keys = ON');
      for (const t of dataTables(store.db)) {
        store.db.exec(`DELETE FROM ${q(t.name)}`);
        const cols = [...(t.virtual ? ['rowid'] : []), ...t.columns];
        const insert = store.db.prepare(`INSERT INTO ${q(t.name)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        const read = snap.prepare(selectAll(t));
        read.setReadBigInts(true);
        read.setReturnArrays(true);
        for (const row of read.iterate()) insert.run(...(row as unknown as (bigint | string | Uint8Array | null)[]));
      }
      // The notes folder is a source like any other, found by its path. Point it at this computer's notes folder,
      // or the next read of the notes would bring every note in again as a new source.
      if (opened.manifest.notesDir !== notes) {
        store.db.prepare(`UPDATE sources SET location = ? WHERE kind = 'notes' AND location = ?`).run(notes, opened.manifest.notesDir);
      }
    });
  } catch (err) {
    if (placed) rmSync(notes, { recursive: true, force: true });
    if (movedOld) renameSync(old, notes);
    rmSync(staging, { recursive: true, force: true });
    throw err;
  } finally {
    snap.close();
  }
  if (movedOld) rmSync(old, { recursive: true, force: true });
  const wrote: string[] = [];
  const kept: string[] = [];
  for (const name of SIDE_FILES) {
    const data = opened.files[name];
    if (!data) continue;
    if (existsSync(join(home, name))) kept.push(name);
    else {
      writeAtomic(join(home, name), data);
      wrote.push(name);
    }
  }
  return { entries: entryCount(store.db), notes: noteFiles.length, wrote, kept };
}
