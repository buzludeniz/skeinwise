// OpenTimestamps: just enough of the format and the calendar protocol to stamp one hash and collect its proof later.
// A proof is a tree of operations (append, prepend, sha256) that starts at the stamped hash and ends in attestations:
// "pending" at a calendar server until it has put the hash into a Bitcoin transaction, then "in Bitcoin block N".
// The files written here are ordinary detached .ots files, so the OpenTimestamps client can read and verify them too.
// Format reference: python-opentimestamps (core/timestamp.py, core/op.py, core/notary.py, core/serialize.py).

import { createHash, randomBytes } from 'node:crypto';

/** The servers `ots stamp` uses by default. Each one batches hashes and passes them to a calendar. */
export const DEFAULT_CALENDARS: readonly string[] = [
  'https://a.pool.opentimestamps.org',
  'https://b.pool.opentimestamps.org',
  'https://a.pool.eternitywall.com',
  'https://ots.btc.catallaxy.com',
];

/** The calendars a pending proof may send us to, as the OpenTimestamps client allows them: https and these hosts. */
export const CALENDAR_DOMAINS: readonly string[] = ['.calendar.opentimestamps.org', '.calendar.eternitywall.com', '.calendar.catallaxy.com'];

const HEADER = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
const VERSION = 1;
const SHA256 = 0x08;
const APPEND = 0xf0;
const PREPEND = 0xf1;
const PENDING_TAG = Buffer.from('83dfe30d2ef90c8e', 'hex');
const BITCOIN_TAG = Buffer.from('0588960d73d71901', 'hex');

const MAX_MSG = 4096;
const MAX_PAYLOAD = 8192;
const MAX_URI = 1000;
const MAX_HEIGHT = 2 ** 32 - 1;
const MAX_DEPTH = 256;
/** The most a calendar may answer with, as in the reference client. */
const MAX_RESPONSE = 10_000;
const URI_CHARS = /^[A-Za-z0-9._/:-]+$/;
const HEADERS = { accept: 'application/vnd.opentimestamps.v1', 'user-agent': 'skeinwise' };

export type Op = { kind: 'sha256' } | { kind: 'append' | 'prepend'; arg: Uint8Array };

export type Attestation =
  | { kind: 'pending'; uri: string }
  | { kind: 'bitcoin'; height: number }
  /** Another chain or a newer kind: kept as it came, never trusted. */
  | { kind: 'unknown'; tag: Uint8Array; payload: Uint8Array };

/** One step of a proof: the message at this point, what attests it, and the operations that lead on from it. */
export interface Timestamp {
  msg: Uint8Array;
  attestations: Attestation[];
  ops: { op: Op; stamp: Timestamp }[];
}

/** A proof file that can't be read: the reason, in plain words. */
export class ProofError extends Error {}

export function timestamp(msg: Uint8Array): Timestamp {
  return { msg, attestations: [], ops: [] };
}

export function sha256(data: Uint8Array): Uint8Array {
  return createHash('sha256').update(data).digest();
}

export function applyOp(op: Op, msg: Uint8Array): Uint8Array {
  const out = op.kind === 'sha256' ? sha256(msg) : op.kind === 'append' ? Buffer.concat([msg, op.arg]) : Buffer.concat([op.arg, msg]);
  if (out.length > MAX_MSG) throw new ProofError(`An operation makes a message of ${out.length} bytes; the most is ${MAX_MSG}.`);
  return out;
}

/** Adds an operation under a step (or finds the same one there) and returns the step it leads to. */
export function addOp(stamp: Timestamp, op: Op): Timestamp {
  const found = stamp.ops.find((o) => sameOp(o.op, op));
  if (found) return found.stamp;
  const next = timestamp(applyOp(op, stamp.msg));
  stamp.ops.push({ op, stamp: next });
  return next;
}

// Writing

class Writer {
  private parts: Uint8Array[] = [];
  bytes(b: Uint8Array): void {
    this.parts.push(b);
  }
  byte(n: number): void {
    this.parts.push(Uint8Array.of(n));
  }
  varuint(n: number): void {
    const out: number[] = [];
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      out.push(b);
    } while (n > 0);
    this.parts.push(Uint8Array.from(out));
  }
  varbytes(b: Uint8Array): void {
    this.varuint(b.length);
    this.bytes(b);
  }
  done(): Uint8Array {
    return Buffer.concat(this.parts);
  }
}

function opBytes(op: Op): Uint8Array {
  const w = new Writer();
  writeOp(w, op);
  return w.done();
}

function writeOp(w: Writer, op: Op): void {
  if (op.kind === 'sha256') return w.byte(SHA256);
  w.byte(op.kind === 'append' ? APPEND : PREPEND);
  w.varbytes(op.arg);
}

function attestationBytes(a: Attestation): Uint8Array {
  const w = new Writer();
  const payload = new Writer();
  if (a.kind === 'pending') {
    w.bytes(PENDING_TAG);
    payload.varbytes(Buffer.from(a.uri));
    w.varbytes(payload.done());
  } else if (a.kind === 'bitcoin') {
    w.bytes(BITCOIN_TAG);
    payload.varuint(a.height);
    w.varbytes(payload.done());
  } else {
    w.bytes(a.tag);
    w.varbytes(a.payload);
  }
  return w.done();
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  return Buffer.compare(a, b);
}

function sameOp(a: Op, b: Op): boolean {
  return compareBytes(opBytes(a), opBytes(b)) === 0;
}

function sameAttestation(a: Attestation, b: Attestation): boolean {
  return compareBytes(attestationBytes(a), attestationBytes(b)) === 0;
}

/** The reference client's layout: attestations first, then operations, each but the last behind 0xff. */
function writeTimestamp(w: Writer, stamp: Timestamp): void {
  const attestations = stamp.attestations.map(attestationBytes).sort(compareBytes);
  const ops = [...stamp.ops].sort((a, b) => compareBytes(opBytes(a.op), opBytes(b.op)));
  if (!attestations.length && !ops.length) throw new ProofError('A proof step with nothing after it cannot be written.');
  const entries = attestations.length + ops.length;
  let written = 0;
  for (const a of attestations) {
    if (++written < entries) w.byte(0xff);
    w.byte(0x00);
    w.bytes(a);
  }
  for (const { op, stamp: next } of ops) {
    if (++written < entries) w.byte(0xff);
    writeOp(w, op);
    writeTimestamp(w, next);
  }
}

export function serializeTimestamp(stamp: Timestamp): Uint8Array {
  const w = new Writer();
  writeTimestamp(w, stamp);
  return w.done();
}

/** A detached .ots file for a SHA-256 digest. */
export function serializeProof(stamp: Timestamp): Uint8Array {
  if (stamp.msg.length !== 32) throw new ProofError('A proof file starts from a 32-byte SHA-256 digest.');
  const w = new Writer();
  w.bytes(HEADER);
  w.byte(VERSION);
  w.byte(SHA256);
  w.bytes(stamp.msg);
  writeTimestamp(w, stamp);
  return w.done();
}

// Reading

class Reader {
  private at = 0;
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  byte(): number {
    if (this.at >= this.buf.length) throw new ProofError('It ends too early.');
    return this.buf[this.at++]!;
  }
  bytes(n: number): Uint8Array {
    if (this.at + n > this.buf.length) throw new ProofError('It ends too early.');
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  varuint(): number {
    let value = 0;
    for (let i = 0, scale = 1; i < 9; i++, scale *= 128) {
      const b = this.byte();
      value += (b & 0x7f) * scale;
      if (!(b & 0x80)) {
        if (value > Number.MAX_SAFE_INTEGER) throw new ProofError('A number in it is too large.');
        return value;
      }
    }
    throw new ProofError('A number in it runs over 9 bytes.');
  }
  varbytes(max: number, min = 0): Uint8Array {
    const n = this.varuint();
    if (n > max || n < min) throw new ProofError(`A field of ${n} bytes is outside ${min} to ${max}.`);
    return this.bytes(n);
  }
  end(): void {
    if (this.at !== this.buf.length) throw new ProofError(`It has ${this.buf.length - this.at} bytes left over at the end.`);
  }
}

function readAttestation(r: Reader): Attestation {
  const tag = r.bytes(8);
  const raw = r.varbytes(MAX_PAYLOAD);
  const payload = new Reader(raw);
  if (compareBytes(tag, PENDING_TAG) === 0) {
    const uri = Buffer.from(payload.varbytes(MAX_URI)).toString('latin1');
    payload.end();
    if (!URI_CHARS.test(uri)) throw new ProofError(`A pending calendar address has characters a calendar never uses: ${JSON.stringify(uri.slice(0, 80))}`);
    return { kind: 'pending', uri };
  }
  if (compareBytes(tag, BITCOIN_TAG) === 0) {
    const height = payload.varuint();
    payload.end();
    if (height > MAX_HEIGHT) throw new ProofError(`Bitcoin block ${height} is beyond any real block height.`);
    return { kind: 'bitcoin', height };
  }
  return { kind: 'unknown', tag: Uint8Array.from(tag), payload: Uint8Array.from(raw) };
}

function readOp(r: Reader, tag: number): Op {
  if (tag === SHA256) return { kind: 'sha256' };
  if (tag === APPEND || tag === PREPEND) return { kind: tag === APPEND ? 'append' : 'prepend', arg: Uint8Array.from(r.varbytes(MAX_MSG, 1)) };
  throw new ProofError(`It uses operation 0x${tag.toString(16).padStart(2, '0')}, which Bitcoin calendars don't use and Skeinwise can't check.`);
}

function readTimestamp(r: Reader, msg: Uint8Array, depth: number): Timestamp {
  if (depth > MAX_DEPTH) throw new ProofError(`It nests deeper than ${MAX_DEPTH} steps.`);
  const stamp = timestamp(msg);
  const one = (tag: number) => {
    if (tag === 0x00) {
      stamp.attestations.push(readAttestation(r));
      return;
    }
    const op = readOp(r, tag);
    if (stamp.ops.some((o) => sameOp(o.op, op))) throw new ProofError('It repeats an operation at one step.');
    stamp.ops.push({ op, stamp: readTimestamp(r, applyOp(op, msg), depth + 1) });
  };
  let tag = r.byte();
  while (tag === 0xff) {
    one(r.byte());
    tag = r.byte();
  }
  one(tag);
  return stamp;
}

/** Reads a calendar's answer: the proof steps that start from the message it was asked about. */
export function parseTimestamp(bytes: Uint8Array, msg: Uint8Array): Timestamp {
  const r = new Reader(bytes);
  const stamp = readTimestamp(r, msg, 1);
  r.end();
  return stamp;
}

/** Reads a detached .ots file for a SHA-256 digest. */
export function parseProof(bytes: Uint8Array): Timestamp {
  const r = new Reader(bytes);
  if (bytes.length < HEADER.length || compareBytes(r.bytes(HEADER.length), HEADER) !== 0) throw new ProofError("It isn't an OpenTimestamps proof file.");
  const version = r.byte();
  if (version !== VERSION) throw new ProofError(`It is a version ${version} proof file; Skeinwise reads version ${VERSION}.`);
  if (r.byte() !== SHA256) throw new ProofError('It stamps a hash other than SHA-256.');
  const stamp = readTimestamp(r, Uint8Array.from(r.bytes(32)), 1);
  r.end();
  return stamp;
}

// Using a proof

/** Puts another proof of the same message into this one: its attestations and operations, step by step. */
export function merge(into: Timestamp, other: Timestamp): void {
  if (compareBytes(into.msg, other.msg) !== 0) throw new ProofError('Two proofs of different messages cannot be merged.');
  for (const a of other.attestations) if (!into.attestations.some((b) => sameAttestation(a, b))) into.attestations.push(a);
  for (const { op, stamp } of other.ops) {
    const same = into.ops.find((o) => sameOp(o.op, op));
    if (same) merge(same.stamp, stamp);
    else into.ops.push({ op, stamp });
  }
}

/** Every attestation in a proof, with the step it attests. */
export function attestations(stamp: Timestamp): { step: Timestamp; attestation: Attestation }[] {
  const out: { step: Timestamp; attestation: Attestation }[] = [];
  const walk = (s: Timestamp) => {
    for (const attestation of s.attestations) out.push({ step: s, attestation });
    for (const o of s.ops) walk(o.stamp);
  };
  walk(stamp);
  return out;
}

export interface BlockProof {
  height: number;
  /** The block's merkle root as block explorers print it (byte-reversed from how the proof holds it). */
  merkleRoot: string;
}

/** The Bitcoin blocks a proof reaches, lowest first. */
export function bitcoinBlocks(stamp: Timestamp): BlockProof[] {
  const blocks = attestations(stamp)
    .filter((a) => a.attestation.kind === 'bitcoin')
    .map(({ step, attestation }) => ({
      height: (attestation as { height: number }).height,
      merkleRoot: Buffer.from(step.msg).reverse().toString('hex'),
    }));
  return blocks.sort((a, b) => a.height - b.height);
}

/** The calendars a proof is still waiting on. */
export function pendingCalendars(stamp: Timestamp): string[] {
  return [...new Set(attestations(stamp).flatMap((a) => (a.attestation.kind === 'pending' ? [a.attestation.uri] : [])))];
}

/** Whether a pending attestation's calendar is one we may ask: https, one of the known calendar hosts, no path. */
export function allowedCalendar(uri: string, domains: readonly string[] = CALENDAR_DOMAINS): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.port &&
    !url.username &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    domains.some((d) => url.hostname.endsWith(d))
  );
}

async function readCapped(res: Response, where: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_RESPONSE) throw new Error(`${where} answered with more than ${MAX_RESPONSE} bytes, more than any proof needs.`);
      parts.push(chunk);
    }
  }
  return Buffer.concat(parts);
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface StampResult {
  /** The proof, still pending at the calendars that answered. */
  proof: Timestamp;
  answered: string[];
  failed: { calendar: string; reason: string }[];
}

/**
 * Stamps a SHA-256 digest: adds a random nonce, hashes again, and sends only that to each calendar, so no calendar
 * learns the digest itself. Throws when no calendar answers.
 */
export async function stamp(
  digest: Uint8Array,
  options: { calendars?: readonly string[]; fetch: typeof fetch; nonce?: Uint8Array; timeoutMs?: number },
): Promise<StampResult> {
  if (digest.length !== 32) throw new Error('Only a 32-byte SHA-256 digest can be stamped.');
  const calendars = options.calendars ?? DEFAULT_CALENDARS;
  const proof = timestamp(Uint8Array.from(digest));
  const tip = addOp(addOp(proof, { kind: 'append', arg: options.nonce ?? randomBytes(16) }), { kind: 'sha256' });
  const answered: string[] = [];
  const failed: { calendar: string; reason: string }[] = [];
  const results = await Promise.all(
    calendars.map(async (calendar) => {
      try {
        const res = await options.fetch(`${calendar.replace(/\/$/, '')}/digest`, {
          method: 'POST',
          headers: { ...HEADERS, 'content-type': 'application/octet-stream' },
          body: Buffer.from(tip.msg),
          signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        });
        if (res.status !== 200) throw new Error(`it answered ${res.status} ${res.statusText}`.trim());
        const answer = parseTimestamp(await readCapped(res, host(calendar)), tip.msg);
        if (!pendingCalendars(answer).length && !bitcoinBlocks(answer).length) throw new Error('its answer attests nothing');
        return { calendar, answer };
      } catch (err) {
        const reason = err instanceof ProofError ? `its answer isn't a proof: ${err.message}` : (err as Error).message;
        return { calendar, reason };
      }
    }),
  );
  for (const r of results) {
    if (r.answer) {
      merge(tip, r.answer);
      answered.push(r.calendar);
    } else failed.push({ calendar: r.calendar, reason: r.reason ?? 'no answer' });
  }
  if (!answered.length) {
    throw new Error(`No calendar server answered: ${failed.map((f) => `${host(f.calendar)} (${f.reason})`).join('; ')}.`);
  }
  return { proof, answered, failed };
}

export interface CollectResult {
  /** Whether the proof gained anything. */
  changed: boolean;
  /** Calendars that said the stamp isn't in Bitcoin yet. */
  waiting: string[];
  /** Calendars that weren't asked, because they aren't on the allowed list. */
  skipped: string[];
  failed: { calendar: string; reason: string }[];
}

/**
 * Asks each calendar a pending proof names for the rest of it, and merges what comes back. A proof that already
 * reaches a Bitcoin block is finished, so it asks nothing.
 */
export async function collect(
  proof: Timestamp,
  options: { fetch: typeof fetch; domains?: readonly string[]; timeoutMs?: number },
): Promise<CollectResult> {
  const result: CollectResult = { changed: false, waiting: [], skipped: [], failed: [] };
  if (bitcoinBlocks(proof).length) return result;
  const before = serializeTimestamp(proof);
  const pending = attestations(proof).filter((a) => a.attestation.kind === 'pending');
  await Promise.all(
    pending.map(async ({ step, attestation }) => {
      const uri = (attestation as { uri: string }).uri;
      if (!allowedCalendar(uri, options.domains)) {
        result.skipped.push(uri);
        return;
      }
      try {
        const res = await options.fetch(`${uri.replace(/\/$/, '')}/timestamp/${Buffer.from(step.msg).toString('hex')}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        });
        if (res.status === 404) {
          await res.body?.cancel();
          result.waiting.push(uri);
          return;
        }
        if (res.status !== 200) throw new Error(`it answered ${res.status} ${res.statusText}`.trim());
        merge(step, parseTimestamp(await readCapped(res, host(uri)), step.msg));
      } catch (err) {
        const reason = err instanceof ProofError ? `its answer isn't a proof: ${err.message}` : (err as Error).message;
        result.failed.push({ calendar: uri, reason });
      }
    }),
  );
  result.changed = compareBytes(before, serializeTimestamp(proof)) !== 0;
  return result;
}
