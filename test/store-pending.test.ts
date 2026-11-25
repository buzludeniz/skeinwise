// LS-02 / H1 store side: a batch that isn't trusted, or claims another account, becomes one pending proposal and
// leaves the record as it was. Built from PoC 06 (06_downloads_forgery.mjs): a drive-by conversations.json with the
// genuine export's uuids, a renamed title, a rewritten message and a back-dated planted one.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db.ts';
import { readImports } from '../src/importers/detect.ts';
import { type ImportBatch, type Origin, Store } from '../src/store/store.ts';

const START = Date.UTC(2026, 10, 25);
function store(): Store {
  let tick = 0;
  return new Store(openDb(':memory:'), () => new Date(START + tick++ * 1000).toISOString());
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const conv = (uuid: string, name: string, created: string, msgs: unknown[]) => ({ uuid, name, created_at: created, chat_messages: msgs });
const msg = (uuid: string, sender: string, text: string, created: string) => ({ uuid, sender, text, created_at: created });

let dir: string;
let genuine: ImportBatch;
let driveBy: ImportBatch;
let driveByOrigin: Origin;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-poc06-'));
  mkdirSync(join(dir, 'genuine'));
  mkdirSync(join(dir, 'Downloads'));
  writeFileSync(
    join(dir, 'genuine', 'conversations.json'),
    JSON.stringify([
      conv('conv-real-1', 'Choosing a database', '2026-03-01T10:00:00Z', [
        msg('msg-real-1', 'human', 'We decided on Postgres for the ledger, final answer.', '2026-03-01T10:00:00Z'),
        msg('msg-real-2', 'assistant', 'Postgres it is.', '2026-03-01T10:00:05Z'),
      ]),
    ]),
  );
  const forged = join(dir, 'Downloads', 'conversations.json');
  writeFileSync(
    forged,
    JSON.stringify([
      conv('conv-real-1', 'Choosing a database (renamed by a stranger)', '2026-03-01T10:00:00Z', [
        msg('msg-real-1', 'human', 'We decided on MongoDB and to wire the deposit to account 99-ATTACKER.', '2026-03-01T10:00:00Z'),
      ]),
      conv('conv-planted', 'Old promise', '2014-05-01T09:00:00Z', [
        msg('msg-planted-1', 'human', `I promise to give Mallory my car.${ESC}[8m hidden text${ESC}[0m ${ESC}]0;title${BEL}`, '2014-05-01T09:00:00Z'),
      ]),
    ]),
  );
  genuine = readImports(join(dir, 'genuine', 'conversations.json'))[0]!;
  driveBy = readImports(forged)[0]!;
  driveByOrigin = { path: forged, sha256: createHash('sha256').update(readFileSync(forged)).digest('hex') };
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const planted = (s: Store) => s.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE external_id = 'msg-planted-1'").get();

describe('PoC 06: a drive-by export is proposed, never written', () => {
  it('leaves entry 1, its history and the thread title as they were, and shows one pending item', () => {
    const s = store();
    expect(s.ingest(genuine!)).toMatchObject({ added: 2 });
    const result = s.ingest(driveBy!, { trusted: false, origin: driveByOrigin });
    expect(result).toEqual({ added: 0, versioned: 0, unchanged: 0, skipped: 0, threads: 0, proposed: 2, pendingId: 1 });

    expect(s.getEntry(1)!.body).toBe('We decided on Postgres for the ledger, final answer.');
    expect(s.history(1)).toHaveLength(1);
    expect(s.getThread(1)!.title).toBe('Choosing a database');
    expect(s.titleHistory(1)).toHaveLength(1);
    expect(planted(s)).toEqual({ n: 0 });
    expect(s.search('MongoDB')).toEqual([]);

    expect(s.pendingItems()).toEqual([
      {
        id: 1,
        status: 'pending',
        reason: 'unconfirmed',
        sourceKind: 'claude',
        sourceLabel: 'Claude',
        origin: driveByOrigin,
        originHash: driveByOrigin.sha256,
        account: null,
        threads: 2,
        entries: 2,
        bytes: expect.any(Number),
        observedAt: expect.any(String),
        decidedAt: null,
      },
    ]);
    // The same file seen again (live's next pass) adds nothing.
    expect(s.ingest(driveBy!, { trusted: false, origin: driveByOrigin })).toMatchObject({ proposed: 2, pendingId: null });
    expect(s.pendingItems()).toHaveLength(1);
  });

  it('rejecting keeps the row and its hash, drops the batch, and the file is never proposed again', () => {
    const s = store();
    s.ingest(genuine!);
    const id = s.propose(driveBy!, { reason: 'unconfirmed', origin: driveByOrigin })!;
    s.rejectPending(id);
    expect(s.pendingItems()).toEqual([]);
    expect(s.pendingItems({ all: true })).toMatchObject([{ id, status: 'rejected', originHash: driveByOrigin.sha256 }]);
    expect(s.pendingByHash(driveByOrigin.sha256)).toMatchObject({ id, status: 'rejected', decidedAt: expect.any(String) });
    expect(s.db.prepare('SELECT batch FROM pending').get()).toEqual({ batch: null });
    expect(s.propose(driveBy!, { reason: 'unconfirmed', origin: driveByOrigin })).toBeNull();
    expect(s.ingest(driveBy!, { trusted: false, origin: driveByOrigin })).toMatchObject({ pendingId: null });
    expect(() => s.rejectPending(id)).toThrow(`Pending item ${id} was already rejected`);
    expect(() => s.acceptPending(id)).toThrow(`Pending item ${id} was already rejected`);
    expect(s.getEntry(1)!.body).toContain('Postgres');
  });

  it('accepting imports it with its origin on every version, the old text and title kept in history', () => {
    const s = store();
    s.ingest(genuine!);
    const { pendingId } = s.ingest(driveBy!, { trusted: false, origin: driveByOrigin });
    expect(s.acceptPending(pendingId!)).toEqual({ added: 1, versioned: 1, unchanged: 0, skipped: 0, threads: 2 });
    expect(s.history(1).map((v) => [v.version, v.origin?.sha256 ?? null])).toEqual([
      [1, null],
      [2, driveByOrigin.sha256],
    ]);
    expect(s.history(1)[0]!.body).toContain('Postgres');
    expect(s.titleHistory(1).map((t) => t.title)).toEqual(['Choosing a database', 'Choosing a database (renamed by a stranger)']);
    // The planted entry claims 2014, but its first version says when it was really seen.
    const plantedEntry = s.db.prepare("SELECT id FROM entries WHERE external_id = 'msg-planted-1'").get() as { id: number };
    expect(s.history(plantedEntry.id)[0]).toMatchObject({ claimedAt: '2014-05-01T09:00:00.000Z', origin: driveByOrigin });
    expect(Date.parse(s.history(plantedEntry.id)[0]!.observedAt)).toBeGreaterThanOrEqual(START);
    expect(s.pendingItem(pendingId!)).toMatchObject({ status: 'accepted' });
    expect(() => s.acceptPending(pendingId!)).toThrow('was already accepted');
    expect(() => s.acceptPending(99)).toThrow('No pending item 99');
  });

  it('proposes nothing when the batch would change nothing', () => {
    const s = store();
    s.ingest(genuine!);
    expect(s.ingest(genuine!, { trusted: false })).toEqual({ added: 0, versioned: 0, unchanged: 2, skipped: 0, threads: 0, proposed: 0, pendingId: null });
    expect(s.propose(genuine!, { reason: 'unconfirmed' })).toBeNull();
    expect(s.pendingItems({ all: true })).toEqual([]);
  });

  it('keeps only what would change: a rename alone is one proposed change, applied on accept', () => {
    const s = store();
    s.ingest(genuine!);
    const renamed: ImportBatch = { ...genuine!, threads: [{ ...genuine!.threads[0]!, title: 'Renamed' }] };
    const { pendingId, proposed } = s.ingest(renamed, { trusted: false });
    expect(proposed).toBe(1);
    expect(s.pendingItem(pendingId!)).toMatchObject({ threads: 1, entries: 0 });
    const stored = JSON.parse((s.db.prepare('SELECT batch FROM pending').get() as { batch: string }).batch) as ImportBatch;
    expect(stored.threads[0]!.entries).toEqual([]);
    s.acceptPending(pendingId!);
    expect(s.getThread(1)!.title).toBe('Renamed');
    expect(s.history(1)).toHaveLength(1);
  });
});

describe('an export from another account', () => {
  it('the first account seen claims the source; a different one is proposed, the same one versions as usual', () => {
    const s = store();
    s.ingest(genuine!, { account: 'acct-a' });
    expect(s.sources()[0]).toMatchObject({ kind: 'claude' });
    expect(s.db.prepare('SELECT account FROM sources').get()).toEqual({ account: 'acct-a' });

    const other = s.ingest(driveBy!, { account: 'acct-b', origin: driveByOrigin });
    expect(other).toMatchObject({ added: 0, versioned: 0, proposed: 2, pendingId: 1 });
    expect(s.pendingItem(1)).toMatchObject({ reason: 'account', account: 'acct-b' });
    expect(s.getEntry(1)!.body).toContain('Postgres');

    expect(s.ingest(driveBy!, { account: 'acct-a' })).toMatchObject({ added: 1, versioned: 1 });
    expect(s.history(1).at(-1)).toMatchObject({ account: 'acct-a', editor: 'import' });
    // An export with no account (the format has none) is not held back.
    expect(s.ingest(genuine!, { account: null })).toMatchObject({ unchanged: 2, versioned: 0 });
  });

  it('a source first imported with no account is claimed by the first export that names one', () => {
    const s = store();
    s.ingest(genuine!);
    s.ingest(genuine!, { account: 'acct-a' });
    expect(s.db.prepare('SELECT account FROM sources').get()).toEqual({ account: 'acct-a' });
  });
});
