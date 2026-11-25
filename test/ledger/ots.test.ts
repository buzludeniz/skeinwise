import { describe, expect, it } from 'vitest';
import {
  addOp,
  allowedCalendar,
  bitcoinBlocks,
  merge,
  parseProof,
  parseTimestamp,
  pendingCalendars,
  ProofError,
  serializeProof,
  serializeTimestamp,
  sha256,
  timestamp,
  type Timestamp,
} from '../../src/ledger/ots.ts';

// The OpenTimestamps format, checked byte by byte against the layout of the reference client (python-opentimestamps).

const DIGEST = sha256(Buffer.from('a ledger line'));
const ALICE = 'https://alice.btc.calendar.opentimestamps.org';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** A proof as a calendar would hand it back once finished: a nonce, then a pending branch and a Bitcoin branch. */
function finished(): Timestamp {
  const root = timestamp(DIGEST);
  const tip = addOp(addOp(root, { kind: 'append', arg: Buffer.alloc(16, 7) }), { kind: 'sha256' });
  addOp(addOp(tip, { kind: 'prepend', arg: Buffer.from('6542b1c0', 'hex') }), { kind: 'sha256' }).attestations.push({ kind: 'pending', uri: ALICE });
  addOp(addOp(tip, { kind: 'append', arg: Buffer.alloc(32, 9) }), { kind: 'sha256' }).attestations.push({ kind: 'bitcoin', height: 870123 });
  return root;
}

describe('the proof file format', () => {
  it('starts with the OpenTimestamps header, version 1, SHA-256 and the digest', () => {
    const bytes = serializeProof(finished());
    expect(hex(bytes.subarray(0, 31))).toBe('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294');
    expect(bytes[31]).toBe(0x01);
    expect(bytes[32]).toBe(0x08);
    expect(hex(bytes.subarray(33, 65))).toBe(hex(DIGEST));
  });

  it('writes attestations and operations as the reference client lays them out', () => {
    const msg = Buffer.alloc(32, 1);
    const pending = timestamp(msg);
    pending.attestations.push({ kind: 'pending', uri: ALICE });
    // 0x00, the 8-byte tag, the payload's length, then the payload: the uri as varbytes.
    expect(hex(serializeTimestamp(pending))).toBe(`00${'83dfe30d2ef90c8e'}2e2d${hex(Buffer.from(ALICE))}`);

    const block = timestamp(msg);
    block.attestations.push({ kind: 'bitcoin', height: 870123 });
    // The height is an unsigned LEB128 number: 870123 = eb 8d 35.
    expect(hex(serializeTimestamp(block))).toBe('000588960d73d7190103eb8d35');

    const ops = timestamp(msg);
    addOp(ops, { kind: 'append', arg: Buffer.from('ab', 'hex') }).attestations.push({ kind: 'bitcoin', height: 1 });
    addOp(ops, { kind: 'sha256' }).attestations.push({ kind: 'bitcoin', height: 2 });
    // Two operations at one step: sorted by tag, the first behind 0xff. sha256 (08) sorts before append (f0).
    expect(hex(serializeTimestamp(ops))).toBe('ff08000588960d73d719010102f001ab000588960d73d719010101');
  });

  it('reads back what it writes, and the merkle root as a block explorer prints it', () => {
    const proof = finished();
    const bytes = serializeProof(proof);
    const read = parseProof(bytes);
    expect(hex(serializeProof(read))).toBe(hex(bytes));
    expect(pendingCalendars(read)).toEqual([ALICE]);
    const tip = sha256(Buffer.concat([sha256(Buffer.concat([DIGEST, Buffer.alloc(16, 7)])), Buffer.alloc(32, 9)]));
    expect(bitcoinBlocks(read)).toEqual([{ height: 870123, merkleRoot: hex(Buffer.from(tip).reverse()) }]);
  });

  it('lists a block once when two calendars reach it by different paths', () => {
    const root = timestamp(DIGEST);
    const a = addOp(addOp(root, { kind: 'prepend', arg: Buffer.from('a') }), { kind: 'sha256' });
    const b = addOp(addOp(root, { kind: 'prepend', arg: Buffer.from('b') }), { kind: 'sha256' });
    // Two leaves of one merkle tree: a's path appends b, b's path prepends a, and both reach the same root.
    const fromA = addOp(addOp(a, { kind: 'append', arg: b.msg }), { kind: 'sha256' });
    const fromB = addOp(addOp(b, { kind: 'prepend', arg: a.msg }), { kind: 'sha256' });
    expect(hex(fromA.msg)).toBe(hex(fromB.msg));
    fromA.attestations.push({ kind: 'bitcoin', height: 870123 });
    fromB.attestations.push({ kind: 'bitcoin', height: 870123 });
    expect(bitcoinBlocks(root)).toEqual([{ height: 870123, merkleRoot: hex(Buffer.from(fromA.msg).reverse()) }]);
  });

  it('keeps an attestation of a kind it does not know, unchanged', () => {
    const msg = Buffer.alloc(32, 1);
    const bytes = Buffer.from(`00${'06869a0d73d71b45'}03eb8d35`, 'hex'); // a Litecoin attestation
    const read = parseTimestamp(bytes, msg);
    expect(read.attestations).toEqual([{ kind: 'unknown', tag: Uint8Array.from(Buffer.from('06869a0d73d71b45', 'hex')), payload: Uint8Array.from([0xeb, 0x8d, 0x35]) }]);
    expect(hex(serializeTimestamp(read))).toBe(hex(bytes));
    expect(bitcoinBlocks(read)).toEqual([]);
  });

  it('refuses what is not a proof, with the reason', () => {
    const good = serializeProof(finished());
    const fails = (bytes: Uint8Array, why: RegExp) => {
      expect(() => parseProof(bytes)).toThrow(ProofError);
      expect(() => parseProof(bytes)).toThrow(why);
    };
    fails(Buffer.from('not a proof at all, but long enough to have a header'), /isn't an OpenTimestamps proof/);
    fails(good.subarray(0, good.length - 3), /ends too early/);
    fails(Buffer.concat([good, Buffer.from([0])]), /left over/);
    const v2 = Buffer.from(good);
    v2[31] = 2;
    fails(v2, /version 2/);
    const msg = Buffer.alloc(32, 1);
    expect(() => parseTimestamp(Buffer.from('67000588960d73d719010101', 'hex'), msg)).toThrow(/operation 0x67/);
    expect(() => parseTimestamp(Buffer.from(`00${'83dfe30d2ef90c8e'}0605${hex(Buffer.from('a b?c'))}`, 'hex'), msg)).toThrow(/characters/);
    expect(() => parseTimestamp(Buffer.from('ff08000588960d73d719010101' + '08000588960d73d719010101', 'hex'), msg)).toThrow(/repeats/);
    const deep = Buffer.concat([Buffer.alloc(300, 0x08), Buffer.from('000588960d73d719010101', 'hex')]);
    expect(() => parseTimestamp(deep, msg)).toThrow(/deeper than 256/);
  });
});

describe('merging and calendars', () => {
  it('merges two answers for the same message step by step', () => {
    const a = timestamp(DIGEST);
    addOp(addOp(a, { kind: 'sha256' }), { kind: 'prepend', arg: Buffer.from('01', 'hex') }).attestations.push({ kind: 'pending', uri: ALICE });
    const b = timestamp(DIGEST);
    addOp(addOp(b, { kind: 'sha256' }), { kind: 'prepend', arg: Buffer.from('02', 'hex') }).attestations.push({ kind: 'pending', uri: 'https://bob.btc.calendar.opentimestamps.org' });
    merge(a, b);
    merge(a, b); // twice changes nothing
    expect(a.ops).toHaveLength(1);
    expect(a.ops[0]!.stamp.ops).toHaveLength(2);
    expect(pendingCalendars(a).sort()).toEqual([ALICE, 'https://bob.btc.calendar.opentimestamps.org']);
    expect(() => merge(a, timestamp(Buffer.alloc(32)))).toThrow(/different messages/);
  });

  it('asks only https calendars on the known hosts', () => {
    expect(allowedCalendar(ALICE)).toBe(true);
    expect(allowedCalendar('https://finney.calendar.eternitywall.com')).toBe(true);
    expect(allowedCalendar('https://btc.calendar.catallaxy.com')).toBe(true);
    expect(allowedCalendar('http://alice.btc.calendar.opentimestamps.org')).toBe(false);
    expect(allowedCalendar('https://alice.btc.calendar.opentimestamps.org:8443')).toBe(false);
    expect(allowedCalendar('https://alice.btc.calendar.opentimestamps.org/other')).toBe(false);
    expect(allowedCalendar('https://calendar.opentimestamps.org.example.com')).toBe(false);
    expect(allowedCalendar('https://example.com')).toBe(false);
    expect(allowedCalendar('not a url')).toBe(false);
  });
});
