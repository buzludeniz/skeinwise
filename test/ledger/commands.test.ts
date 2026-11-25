import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx, Values } from '../../src/cli-organiser.ts';
import type { Io } from '../../src/cli.ts';
import { UsageError } from '../../src/errors.ts';
import { LEDGER_COMMANDS } from '../../src/ledger/commands.ts';
import { catchUpLedger, ledgerPath, lineHash, readLedgerText } from '../../src/ledger/ledger.ts';
import { addOp, bitcoinBlocks, DEFAULT_CALENDARS, parseProof, pendingCalendars, serializeTimestamp, timestamp } from '../../src/ledger/ots.ts';
import { proofPath } from '../../src/ledger/stamps.ts';
import { demoRecord, type TempRecord } from './record.ts';

// `skeinwise ledger verify|stamp|collect` against a fake OpenTimestamps calendar. No real server is contacted: the
// fake answers for the default pool servers and the calendars they hand out, and anything else fails the test.

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Which calendar each pool server hands a stamp to, as the real pools do. */
const POOLS: Record<string, string> = {
  'https://a.pool.opentimestamps.org': 'https://alice.btc.calendar.opentimestamps.org',
  'https://b.pool.opentimestamps.org': 'https://bob.btc.calendar.opentimestamps.org',
  'https://a.pool.eternitywall.com': 'https://finney.calendar.eternitywall.com',
  'https://ots.btc.catallaxy.com': 'https://btc.calendar.catallaxy.com',
};

class FakeCalendar {
  requests: string[] = [];
  /** What the pools were sent: the hash each stamp request carried. */
  sent: string[] = [];
  /** Servers that can't be reached. */
  down = new Set<string>();
  /** A pool that hands its stamps to this address instead. */
  handOut = new Map<string, string>();
  /** Once true, the calendars answer with a Bitcoin block. */
  mined = false;
  private commitments = new Map<string, string>();

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${url.href}`);
    if (!Object.keys(POOLS).includes(url.origin) && !Object.values(POOLS).includes(url.origin)) {
      throw new Error(`The test calendar doesn't know ${url.href}`);
    }
    if (this.down.has(url.origin)) throw new TypeError('fetch failed');
    if (method === 'POST' && url.pathname === '/digest') {
      const tip = new Uint8Array(init!.body as Uint8Array);
      this.sent.push(hex(tip));
      const calendar = this.handOut.get(url.origin) ?? POOLS[url.origin]!;
      const answer = timestamp(tip);
      const step = addOp(addOp(answer, { kind: 'prepend', arg: Buffer.from(new URL(calendar).host) }), { kind: 'sha256' });
      step.attestations.push({ kind: 'pending', uri: calendar });
      this.commitments.set(hex(step.msg), calendar);
      return ok(serializeTimestamp(answer));
    }
    const asked = /^\/timestamp\/([0-9a-f]{64})$/.exec(url.pathname)?.[1];
    if (method === 'GET' && asked && this.commitments.get(asked) === url.origin) {
      if (!this.mined) return new Response('Pending confirmation in Bitcoin blockchain', { status: 404 });
      const answer = timestamp(Buffer.from(asked, 'hex'));
      addOp(addOp(answer, { kind: 'append', arg: Buffer.alloc(32, 5) }), { kind: 'sha256' }).attestations.push({ kind: 'bitcoin', height: 870123 });
      return ok(serializeTimestamp(answer));
    }
    return new Response('Not found', { status: 404 });
  }) as typeof fetch;
}

function ok(bytes: Uint8Array): Response {
  return new Response(new Uint8Array(bytes), { status: 200 });
}

let rec: TempRecord;
let cal: FakeCalendar;
beforeEach(() => {
  rec = demoRecord();
  cal = new FakeCalendar();
});
afterEach(() => rec.close());

/** Runs `skeinwise ledger <args>` with a Ctx built here, as cli.ts would. */
async function ledger(args: string[], values: Values = {}, io: Partial<Io> = {}) {
  let out = '';
  const json: unknown[] = [];
  const ctx: Ctx = {
    io: { out: (t) => (out += t), err: () => {}, env: {}, fetch: cal.fetch, ...io },
    home: rec.home,
    store: rec.store,
    values,
    args,
    json: (v) => json.push(v),
  };
  const code = await LEDGER_COMMANDS.ledger!(ctx);
  return { code, out, json: json[0] as Record<string, unknown> | undefined };
}

const lastLine = () => readLedgerText(rec.home).lines.length;
const answer = (reply: string | null) => ({ ask: async () => reply });

describe('skeinwise ledger', () => {
  it('names its three commands when given another word', async () => {
    await expect(ledger([])).rejects.toThrow(/Give one of: skeinwise ledger verify, skeinwise ledger stamp, skeinwise ledger collect/);
    await expect(ledger(['sign'])).rejects.toThrow(UsageError);
    await expect(ledger(['verify', 'now'])).rejects.toThrow(/takes no more words/);
  });
});

describe('skeinwise ledger verify', () => {
  it('says an empty ledger is empty', async () => {
    const { code, out } = await ledger(['verify']);
    expect(code).toBe(0);
    expect(out).toMatch(/The ledger is empty/);
  });

  it('checks the chain and the record, and names the first broken line', async () => {
    catchUpLedger(rec.store, rec.home);
    const good = await ledger(['verify']);
    expect(good.code).toBe(0);
    expect(good.out).toMatch(/The chain holds/);
    expect(good.out).toMatch(/The record matches it: \d+ versions checked against their text/);
    expect(good.out).toMatch(/No stamps yet/);

    const lines = readLedgerText(rec.home).lines;
    lines[1] = lines[1]!.replace('"count":', '"count":1');
    writeFileSync(ledgerPath(rec.home), `${lines.join('\n')}\n`);
    const bad = await ledger(['verify']);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/The chain breaks at line 3\. Line 3 doesn't follow on from line 2/);
    expect(cal.requests).toEqual([]);
  });

  it('answers in JSON', async () => {
    catchUpLedger(rec.store, rec.home);
    const { code, json } = await ledger(['verify'], { json: true });
    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, lines: lastLine(), chain: null, record: null, stamps: [] });
    expect(json!.latest).toBe(lineHash(readLedgerText(rec.home).lines.at(-1)!));
  });
});

describe('skeinwise ledger stamp', () => {
  it('asks before it sends anything, and refuses without an answer or --yes', async () => {
    await expect(ledger(['stamp'])).rejects.toThrow(/Add --yes to send it/);
    let question = '';
    const no = await ledger(['stamp'], {}, { ask: async (q) => ((question = q), 'n') });
    expect(no.code).toBe(0);
    expect(question).toBe('Send it now? [y/N] ');
    expect(no.out).toMatch(/a\.pool\.opentimestamps\.org, b\.pool\.opentimestamps\.org, a\.pool\.eternitywall\.com and ots\.btc\.catallaxy\.com/);
    expect(no.out).toMatch(/Nothing was sent/);
    expect(cal.requests).toEqual([]);
    expect(existsSync(proofPath(rec.home, lastLine()))).toBe(false);
  });

  it('catches the ledger up, stamps its last line at every calendar, and only sends a hash of the line hash', async () => {
    const { code, out } = await ledger(['stamp'], {}, answer('yes'));
    expect(code).toBe(0);
    const n = lastLine();
    expect(n).toBeGreaterThan(1);
    expect(cal.requests).toEqual(DEFAULT_CALENDARS.map((c) => `POST ${c}/digest`));
    const latest = lineHash(readLedgerText(rec.home).lines[n - 1]!);
    expect(new Set(cal.sent).size).toBe(1);
    expect(cal.sent[0]).not.toBe(latest);
    expect(out).toMatch(new RegExp(`Stamped line ${n} at a\\.pool\\.opentimestamps\\.org`));

    const proof = parseProof(readFileSync(proofPath(rec.home, n)));
    expect(hex(proof.msg)).toBe(latest);
    expect(pendingCalendars(proof).sort()).toEqual(Object.values(POOLS).sort());

    // Again, with nothing new: it says so and sends nothing.
    const again = await ledger(['stamp'], { yes: true });
    expect(again.out).toMatch(new RegExp(`Line ${n} is stamped already, so nothing was sent`));
    expect(cal.requests).toHaveLength(4);
  });

  it('stamps with the calendars that answer, and fails when none does', async () => {
    cal.down.add('https://b.pool.opentimestamps.org');
    const some = await ledger(['stamp'], { yes: true });
    expect(some.code).toBe(0);
    expect(some.out).toMatch(/b\.pool\.opentimestamps\.org didn't take it: fetch failed/);
    expect(pendingCalendars(parseProof(readFileSync(proofPath(rec.home, lastLine()))))).toHaveLength(3);

    rec.store.editEntry(rec.store.allEntries()[0]!.id, 'A later thought.', 'you');
    for (const pool of Object.keys(POOLS)) cal.down.add(pool);
    await expect(ledger(['stamp'], { yes: true })).rejects.toThrow(/No calendar server answered/);
    expect(existsSync(proofPath(rec.home, lastLine()))).toBe(false);
  });

  it('refuses to stamp a ledger whose chain is broken', async () => {
    catchUpLedger(rec.store, rec.home);
    const lines = readLedgerText(rec.home).lines;
    lines[0] = lines[0]!.replace('"count":', '"count":1');
    writeFileSync(ledgerPath(rec.home), `${lines.join('\n')}\n`);
    await expect(ledger(['stamp'], { yes: true })).rejects.toThrow(/chain breaks at line 2/);
    expect(cal.requests).toEqual([]);
  });
});

describe('skeinwise ledger collect', () => {
  it('has nothing to collect before a stamp, and contacts nobody', async () => {
    const { code, out } = await ledger(['collect'], { yes: true });
    expect(code).toBe(0);
    expect(out).toMatch(/Nothing is stamped yet/);
    expect(cal.requests).toEqual([]);
  });

  it('asks the calendars, waits while they wait, then stores the finished proof', async () => {
    await ledger(['stamp'], { yes: true });
    const n = lastLine();
    const path = proofPath(rec.home, n);
    const pending = readFileSync(path);
    cal.requests = [];

    await expect(ledger(['collect'])).rejects.toThrow(/Add --yes to ask them/);
    expect(cal.requests).toEqual([]);

    const waiting = await ledger(['collect'], {}, answer('y'));
    expect(waiting.code).toBe(0);
    expect(waiting.out).toMatch(/not in Bitcoin yet at .*That usually takes a few hours/);
    expect(cal.requests).toHaveLength(4);
    expect(cal.requests.every((r) => r.startsWith('GET https://') && r.includes('/timestamp/'))).toBe(true);
    expect(readFileSync(path).equals(pending)).toBe(true);

    cal.mined = true;
    const done = await ledger(['collect'], { yes: true });
    expect(done.code).toBe(0);
    expect(done.out).toMatch(new RegExp(`line ${n}: in Bitcoin block 870123`));
    const proof = parseProof(readFileSync(path));
    // Each calendar's branch reaches the block; the fake gives each its own merkle path.
    expect(bitcoinBlocks(proof).map((b) => b.height)).toEqual([870123, 870123, 870123, 870123]);
    expect(pendingCalendars(proof)).toHaveLength(4);

    const verify = await ledger(['verify']);
    expect(verify.code).toBe(0);
    expect(verify.out).toMatch(new RegExp(`Stamps:\\n  line ${n}: in Bitcoin block 870123\\. A block explorer shows that block's merkle root as [0-9a-f]{64}`));

    cal.requests = [];
    const after = await ledger(['collect'], { yes: true });
    expect(after.out).toMatch(/No stamp is waiting/);
    expect(cal.requests).toEqual([]);
  });

  it('asks only known calendars, and fails when it can reach none of them', async () => {
    cal.handOut.set('https://a.pool.opentimestamps.org', 'https://calendar.example.com');
    await ledger(['stamp'], { yes: true });
    cal.requests = [];
    for (const c of Object.values(POOLS)) cal.down.add(c);
    const { code, out } = await ledger(['collect'], { yes: true });
    expect(code).toBe(1);
    expect(out).toMatch(/not asked https:\/\/calendar\.example\.com, because it isn't a known OpenTimestamps calendar/);
    expect(out).toMatch(/bob\.btc\.calendar\.opentimestamps\.org couldn't be asked: fetch failed/);
    expect(cal.requests.some((r) => r.includes('example.com'))).toBe(false);
    expect(cal.requests).toHaveLength(3);
  });
});

describe('what a stamp catches', () => {
  it('sees the stamped last line changed, which the chain alone cannot', async () => {
    await ledger(['stamp'], { yes: true });
    const lines = readLedgerText(rec.home).lines;
    const n = lines.length;
    lines[n - 1] = lines[n - 1]!.replace(/"at":"[^"]+"/, '"at":"2020-01-01T00:00:00.000Z"');
    writeFileSync(ledgerPath(rec.home), `${lines.join('\n')}\n`);
    const { code, out } = await ledger(['verify']);
    expect(code).toBe(1);
    expect(out).toMatch(/The chain holds/);
    expect(out).toMatch(new RegExp(`line ${n}: line-${n}\\.ots stamps a different line ${n}: the line was changed after it was stamped`));
  });
});
