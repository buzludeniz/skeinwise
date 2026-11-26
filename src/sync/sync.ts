// Encrypted sync through a folder you pick, such as one a cloud drive keeps in step between your computers. The folder
// holds two files: skeinwise.keys (the sync key, wrapped twice) and skeinwise.bundle (the whole record, encrypted).
// This computer remembers the folder and the key in the record folder's sync.json. Nothing goes to any server.
//
// One computer starts the sync (init), any computer writes a fresh bundle (push), and another computer with an empty
// record becomes a copy (join with the passphrase, restore with the recovery phrase). A push replaces the bundle, so
// push refuses when another computer pushed since this one last pushed or joined, unless forced.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { UsageError } from '../errors.ts';
import type { Store } from '../store/store.ts';
import { BUNDLE_FILE, type BundleHeader, type Joined, joinBundle, notEmpty, openBundle, readHeader, sealBundle, writeAtomic } from './bundle.ts';
import { checkPassphrase, KEYS_FILE, type KdfParams, type KeyFile, makeKeyFile, newKey, newPhrase, parseKeyFile, parsePhrase, SCRYPT, type SlotName, unwrapKey } from './keys.ts';

export const STATE_FILE = 'sync.json';

/** What this computer keeps about its sync, in the record folder (owner-only, like the record itself). */
export interface SyncState {
  format: 1;
  folder: string;
  keyId: string;
  /** The sync key in base64. It sits next to the record it encrypts. v1.0 hides sync; the key scheme's
   * write-up is in git history (`git log -- docs/sync.md`). */
  key: string;
  /** A random id for this computer, written into each bundle it pushes. */
  computer: string;
  /** The push number of the newest bundle this computer wrote or joined from. */
  seq: number;
  at: string;
}

export function statePath(home: string): string {
  return join(home, STATE_FILE);
}

export function readState(home: string): SyncState | null {
  const file = statePath(home);
  if (!existsSync(file)) return null;
  const state = JSON.parse(readFileSync(file, 'utf8')) as SyncState;
  if (state?.format !== 1 || typeof state.folder !== 'string' || typeof state.key !== 'string' || !Number.isInteger(state.seq)) {
    throw new Error(`${file} is damaged. Move it aside and join the sync folder again.`);
  }
  return state;
}

function writeState(home: string, state: SyncState): void {
  writeAtomic(statePath(home), `${JSON.stringify(state, null, 2)}\n`);
}

function readKeyFile(folder: string): KeyFile {
  const file = join(folder, KEYS_FILE);
  if (!existsSync(file)) {
    throw new UsageError(existsSync(folder) ? `${folder} holds no Skeinwise sync: there is no ${KEYS_FILE} in it.` : `There is no folder at ${folder}.`);
  }
  return parseKeyFile(readFileSync(file, 'utf8'), file);
}

// init

/** Refuses, before any passphrase is asked for, when this record already syncs or the folder already holds a sync. */
export function checkStart(home: string, folder: string): string {
  const state = readState(home);
  if (state) throw new UsageError(`This record already syncs with ${state.folder}. Write a fresh bundle there with: skeinwise sync push`);
  const dir = resolve(folder);
  const record = resolve(home);
  if (dir === record || dir.startsWith(record + sep)) {
    throw new UsageError(`${dir} is inside the record folder, so each bundle would hold the one before it. Pick a folder outside ${record}.`);
  }
  if (statSync(dir, { throwIfNoEntry: false })?.isFile()) throw new UsageError(`${dir} is a file. Give a folder.`);
  if (existsSync(join(dir, KEYS_FILE)) || existsSync(join(dir, BUNDLE_FILE))) {
    throw new UsageError(`${dir} already holds a Skeinwise sync. To make this computer a copy of it: skeinwise sync join ${dir}`);
  }
  return dir;
}

export interface Started {
  folder: string;
  keyId: string;
  seq: number;
  entries: number;
  bytes: number;
  /** The recovery phrase. It is in no file: show it once, and let it go. */
  phrase: string;
}

/** Starts syncing to a folder: a new key, its two wrapped copies, and the first bundle. */
export function startSync(store: Store, home: string, folder: string, passphrase: string, params: KdfParams = SCRYPT): Started {
  const dir = checkStart(home, folder);
  const pass = checkPassphrase(passphrase);
  const { key, keyId } = newKey();
  const phrase = newPhrase();
  const computer = randomBytes(8).toString('hex');
  const keyFile = makeKeyFile(key, keyId, pass, phrase, store.now(), params);
  const { bytes, entries } = sealBundle(store, home, key, { keyId, seq: 1, writer: computer });
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  try {
    writeAtomic(join(dir, BUNDLE_FILE), bytes);
    written.push(join(dir, BUNDLE_FILE));
    writeAtomic(join(dir, KEYS_FILE), `${JSON.stringify(keyFile, null, 2)}\n`);
    written.push(join(dir, KEYS_FILE));
    writeState(home, { format: 1, folder: dir, keyId, key: key.toString('base64'), computer, seq: 1, at: store.now() });
  } catch (err) {
    for (const file of written) rmSync(file, { force: true });
    throw err;
  }
  return { folder: dir, keyId, seq: 1, entries, bytes: bytes.length, phrase };
}

// push

export interface Pushed {
  folder: string;
  seq: number;
  entries: number;
  bytes: number;
  /** The bundle another computer had pushed, when --force replaced it. */
  replaced: BundleHeader | null;
}

/** The bundle now in the folder, by its header (not yet checked), or null when there is none. */
function folderBundle(folder: string): BundleHeader | null {
  const file = join(folder, BUNDLE_FILE);
  return existsSync(file) ? readHeader(readFileSync(file), file).header : null;
}

/** Writes a fresh bundle of the whole record to the folder. */
export function pushSync(store: Store, home: string, options: { force?: boolean } = {}): Pushed {
  const state = readState(home);
  if (!state) throw new UsageError('This record does not sync yet. Start with: skeinwise sync init <folder>');
  const keys = readKeyFile(state.folder);
  if (keys.keyId !== state.keyId) {
    throw new UsageError(`${state.folder} now holds a different sync (its key file was replaced), so this computer can't push to it. Nothing was written.`);
  }
  let current: BundleHeader | null;
  try {
    current = folderBundle(state.folder);
  } catch (err) {
    if (!options.force) throw new Error(`${(err as Error).message} Replace it with a fresh bundle: skeinwise sync push --force`);
    current = null;
  }
  const ahead = current !== null && current.keyId === state.keyId && current.seq > state.seq;
  if (current && current.keyId !== state.keyId && !options.force) {
    throw new UsageError(`The bundle in ${state.folder} belongs to a different sync. Replace it with this record: skeinwise sync push --force`);
  }
  if (ahead && !options.force) {
    throw new UsageError(
      `Another computer pushed to ${state.folder} (push ${current!.seq}, ${current!.createdAt}) since this one last pushed or joined (push ${state.seq}).\n` +
        'Pushing now would replace that bundle, and what that computer added since would be in no bundle (it stays on that computer).\n' +
        "Skeinwise can't merge two records yet. Nothing was written. To replace it anyway: skeinwise sync push --force",
    );
  }
  const seq = Math.max(current?.seq ?? 0, state.seq) + 1;
  const { bytes, entries } = sealBundle(store, home, Buffer.from(state.key, 'base64'), { keyId: state.keyId, seq, writer: state.computer });
  writeAtomic(join(state.folder, BUNDLE_FILE), bytes);
  writeState(home, { ...state, seq, at: store.now() });
  return { folder: state.folder, seq, entries, bytes: bytes.length, replaced: ahead ? current : null };
}

// join and restore

/** Refuses, before any secret is asked for, when this record can't join: it syncs already, isn't empty, or the folder holds no sync. */
export function checkJoin(store: Store, home: string, folder: string): string {
  const state = readState(home);
  if (state) throw new UsageError(`This record already syncs with ${state.folder}.`);
  const dir = resolve(folder);
  readKeyFile(dir);
  if (!existsSync(join(dir, BUNDLE_FILE))) throw new UsageError(`${dir} has a key file but no bundle. Push one from a computer that syncs with it: skeinwise sync push`);
  const why = notEmpty(store, home);
  if (why) {
    throw new UsageError(
      `This record is not empty: ${why}. Joining makes a record a copy of the folder's, so it only goes into an empty one. Nothing was written.\n` +
        `Join with a new record folder instead, for example:\n  SKEINWISE_HOME=~/skeinwise-joined skeinwise sync join ${dir}\nor move ${home} aside first.`,
    );
  }
  return dir;
}

export type Secret = { passphrase: string } | { phrase: string };

export interface JoinedSync extends Joined {
  folder: string;
  seq: number;
  pushedAt: string;
}

/** Makes this computer's empty record a copy of the folder's, opened with the passphrase or the recovery phrase. */
export function joinSync(store: Store, home: string, folder: string, secret: Secret): JoinedSync {
  const dir = checkJoin(store, home, folder);
  const keys = readKeyFile(dir);
  const slot: SlotName = 'passphrase' in secret ? 'passphrase' : 'phrase';
  const value = 'passphrase' in secret ? secret.passphrase.normalize('NFC') : parsePhrase(secret.phrase);
  const key = unwrapKey(keys.slots[slot], keys.keyId, slot, value);
  if (!key) {
    throw new UsageError(
      slot === 'passphrase'
        ? `That passphrase does not open the sync in ${dir}. Nothing was written. If it is lost, use the recovery phrase: skeinwise sync restore ${dir}`
        : `That recovery phrase does not open the sync in ${dir}. Nothing was written.`,
    );
  }
  const file = join(dir, BUNDLE_FILE);
  const opened = openBundle(readFileSync(file), key, keys.keyId, file);
  const joined = joinBundle(store, home, opened, file);
  writeState(home, { format: 1, folder: dir, keyId: keys.keyId, key: key.toString('base64'), computer: randomBytes(8).toString('hex'), seq: opened.header.seq, at: store.now() });
  return { folder: dir, seq: opened.header.seq, pushedAt: opened.header.createdAt, ...joined };
}

// status

export interface Status {
  syncing: boolean;
  folder?: string;
  /** The push this computer last wrote or joined from, and when. */
  seq?: number;
  at?: string;
  /** The bundle now in the folder, when it can be read. */
  folderSeq?: number;
  folderAt?: string;
  /** True when another computer pushed since this one last pushed or joined. */
  behind?: boolean;
  problem?: string;
}

export function syncStatus(home: string): Status {
  const state = readState(home);
  if (!state) return { syncing: false };
  const status: Status = { syncing: true, folder: state.folder, seq: state.seq, at: state.at };
  try {
    const keys = readKeyFile(state.folder);
    if (keys.keyId !== state.keyId) return { ...status, problem: 'the folder now holds a different sync' };
    const current = folderBundle(state.folder);
    if (!current) return { ...status, problem: 'the folder has no bundle; write one with: skeinwise sync push' };
    return { ...status, folderSeq: current.seq, folderAt: current.createdAt, behind: current.seq > state.seq };
  } catch (err) {
    return { ...status, problem: (err as Error).message };
  }
}
