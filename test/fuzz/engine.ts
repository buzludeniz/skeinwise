// The fuzz engine: it mutates seed inputs with a seeded generator and runs a parser of untrusted input on each one,
// checking what every target promises. It returns a valid result or throws its own typed refusal; it takes no longer
// than the time budget, no more memory than its caps allow, and writes nothing outside its own folder. Hangs and
// crashes need a thread to watch from: pool.ts runs `loop` in a worker and watches it.
//
// Every input is built from the seed, the target and the iteration alone, so any finding replays exactly, and nothing
// hostile is ever committed: the seed inputs are built here at run time.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8 } from 'fflate';
import { mulberry32 } from '../../src/random.ts';
import { beginWrites, endWrites, leftOpen } from './guard.ts';

export type Rng = () => number;

export interface Target {
  name: string;
  /** Whose code it is. A finding in code this track doesn't own goes to the lead with its seed, unfixed. */
  owner: string;
  /** Valid inputs to start from. Built once per run. */
  seeds: () => Uint8Array[];
  /** Words worth inserting: the syntax the parser cares about. One with only bytes 0 to 255 is used as raw bytes. */
  tokens: string[];
  /** The input is written to this file in the target's folder before each run, for targets that read files. */
  fileName?: string;
  /**
   * Runs one input (`file` holds it when `fileName` is set). Throws a refusal it promises, or anything else on a bug.
   * It may return a promise: the input is done when it settles, and one that never settles is a hang.
   */
  run: (input: Uint8Array, file: string) => void | Promise<void>;
  /** Makes the target's folder ready: once in each worker, before its first input and before the write guard is on. */
  setUp?: (folder: string) => void;
  /** Where in its folder the target may write, when that is narrower than the folder itself. */
  writesIn?: (folder: string) => string;
  /** The errors that are the parser saying no, as it should. */
  refused: (error: unknown) => boolean;
  /** A mutation that knows the format, used instead of the generic one (which it may call). */
  mutate?: (rng: Rng, seed: Uint8Array, generic: (bytes: Uint8Array) => Uint8Array) => Uint8Array;
  /** The most memory one input may take, in MiB: the target's caps for an input of at most MAX_INPUT, with room. */
  memoryMiB: number;
}

export type FindingKind = 'error' | 'slow' | 'write' | 'memory' | 'leak' | 'hang' | 'crash';

export interface Finding {
  target: string;
  owner: string;
  kind: FindingKind;
  seed: number;
  iteration: number;
  ms: number;
  error: string;
}

/** The largest input a mutation builds. */
export const MAX_INPUT = 1024 * 1024;

/**
 * The time every zip a target builds is stamped with. Left out, fflate stamps the current time, so two builds of one
 * input differ when the clock passes a 2-second step between them, and a replay builds other bytes. Written as local
 * time, it gives the same date fields in every time zone.
 */
export const ZIP_TIME = '2026-11-25T12:00:00';

export const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
export const int = (rng: Rng, below: number): number => Math.floor(rng() * below);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function repeat(chunk: Uint8Array, times: number): Uint8Array {
  const out = new Uint8Array(chunk.length * times);
  for (let i = 0; i < times; i++) out.set(chunk, i * chunk.length);
  return out;
}

const INTERESTING = [0x00, 0x0a, 0x0d, 0x1b, 0x20, 0x22, 0x23, 0x26, 0x2d, 0x2f, 0x3a, 0x3b, 0x3c, 0x3e, 0x50, 0x4b, 0x5b, 0x5d, 0x7f, 0x80, 0x9b, 0x9c, 0x9d, 0xbf, 0xc0, 0xd8, 0xdc, 0xef, 0xfe, 0xff];

/** One to four generic mutations: bit flips, odd bytes, cuts, deletions, splices from the seeds, long repeats, tokens. */
export function mutateBytes(rng: Rng, input: Uint8Array, seeds: Uint8Array[], tokens: Uint8Array[]): Uint8Array {
  let bytes = input;
  for (let n = 1 + int(rng, 4); n > 0; n--) {
    const at = int(rng, bytes.length + 1);
    switch (int(rng, 8)) {
      case 0: {
        bytes = bytes.slice();
        for (let k = 1 + int(rng, 8); k > 0 && bytes.length; k--) bytes[int(rng, bytes.length)]! ^= 1 << int(rng, 8);
        break;
      }
      case 1: {
        bytes = bytes.slice();
        for (let k = 1 + int(rng, 4); k > 0 && bytes.length; k--) bytes[int(rng, bytes.length)] = pick(rng, INTERESTING);
        break;
      }
      case 2:
        bytes = bytes.subarray(0, at);
        break;
      case 3:
        bytes = concat(bytes.subarray(0, at), bytes.subarray(Math.min(bytes.length, at + 1 + int(rng, 64))));
        break;
      case 4: {
        const other = pick(rng, seeds);
        const from = int(rng, other.length);
        bytes = concat(bytes.subarray(0, at), other.subarray(from, from + 1 + int(rng, 256)), bytes.subarray(at));
        break;
      }
      case 5: {
        // A chunk repeated many times: the shape that makes a backtracking parser slow.
        const chunk = bytes.subarray(at, at + 1 + int(rng, 16));
        const times = Math.min(1 << int(rng, 17), Math.floor(MAX_INPUT / Math.max(1, chunk.length)));
        bytes = concat(bytes.subarray(0, at), repeat(chunk, times), bytes.subarray(at));
        break;
      }
      default: {
        const token = pick(rng, tokens);
        const times = rng() < 0.2 ? Math.min(1 << int(rng, 14), Math.floor(MAX_INPUT / Math.max(1, token.length))) : 1;
        bytes = concat(bytes.subarray(0, at), repeat(token, times), bytes.subarray(at));
        break;
      }
    }
    if (bytes.length > MAX_INPUT) bytes = bytes.subarray(0, MAX_INPUT);
  }
  return bytes;
}

/** The numeric fields of a zip's headers, by signature: [offset, width]. */
const ZIP_FIELDS = new Map<number, Array<[number, 2 | 4]>>([
  // Local header: method, CRC, packed size, size, name length, extra length.
  [0x04034b50, [[8, 2], [14, 4], [18, 4], [22, 4], [26, 2], [28, 2]]],
  // Central directory entry: method, CRC, packed size, size, name, extra and comment lengths, local header offset.
  [0x02014b50, [[10, 2], [16, 4], [20, 4], [24, 4], [28, 2], [30, 2], [32, 2], [42, 4]]],
  // End of central directory: entries on this disk, entries, directory size, directory offset, comment length.
  [0x06054b50, [[8, 2], [10, 2], [12, 4], [16, 4], [20, 2]]],
]);
const FIELD_VALUES = [0, 1, 2, 30, 0x7f, 0xff, 0x100, 0xfffe, 0xffff, 0x10000, 0x7fffffff, 0xfffffffe, 0xffffffff];

/** Sets one numeric field of a zip header (a size, an offset, a count, a length) to a value at an edge. */
export function mutateZipField(rng: Rng, bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers: Array<[number, Array<[number, 2 | 4]>]> = [];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] !== 0x50 || bytes[i + 1] !== 0x4b) continue;
    const fields = ZIP_FIELDS.get(view.getUint32(i, true));
    if (fields) headers.push([i, fields]);
  }
  if (!headers.length) return bytes;
  const [header, fields] = pick(rng, headers);
  const [offset, width] = pick(rng, fields);
  const at = header + offset;
  if (at + width > bytes.length) return bytes;
  const out = bytes.slice();
  const outView = new DataView(out.buffer);
  const old = width === 2 ? outView.getUint16(at, true) : outView.getUint32(at, true);
  const value = pick(rng, [...FIELD_VALUES, old + 1, old - 1, old * 2, Math.floor(old / 2), int(rng, 2 ** 32)]) >>> 0;
  if (width === 2) outView.setUint16(at, value & 0xffff, true);
  else outView.setUint32(at, value, true);
  return out;
}

interface Prepared {
  seeds: Uint8Array[];
  tokens: Uint8Array[];
}
const prepared = new Map<Target, Prepared>();

function tokenBytes(token: string): Uint8Array {
  return /^[\x00-\xff]*$/.test(token) ? Uint8Array.from(token, (c) => c.charCodeAt(0)) : strToU8(token);
}

/** A target's seeds and tokens, built once. */
export function prepare(target: Target): Prepared {
  let ready = prepared.get(target);
  if (!ready) {
    ready = { seeds: target.seeds(), tokens: target.tokens.map(tokenBytes) };
    prepared.set(target, ready);
  }
  return ready;
}

/** A generator for one iteration, so any finding replays from its seed and iteration alone. */
function rngFor(seed: number, target: string, iteration: number): Rng {
  let h = seed >>> 0;
  for (const c of target) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return mulberry32((h ^ Math.imul(iteration + 1, 0x9e3779b1)) >>> 0);
}

/** The input for one iteration of a target. */
export function inputFor(target: Target, seed: number, iteration: number): Uint8Array {
  const rng = rngFor(seed, target.name, iteration);
  const { seeds, tokens } = prepare(target);
  const start = pick(rng, seeds);
  const generic = (bytes: Uint8Array) => mutateBytes(rng, bytes, seeds, tokens);
  return target.mutate ? target.mutate(rng, start, generic) : generic(start);
}

export interface Outcome {
  kind?: FindingKind;
  error?: string;
  /** The target said no, as it promises to. */
  refused?: boolean;
  ms: number;
}

const describe = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : `threw a ${typeof e}: ${String(e)}`);

/** Runs one input in this thread: a finding when it breaks a promise the target makes, except for hangs and crashes. */
export async function runOne(target: Target, input: Uint8Array, folder: string, budgetMs: number): Promise<Outcome> {
  const file = target.fileName ? join(folder, target.fileName) : '';
  if (file) writeFileSync(file, input);
  beginWrites(target.writesIn?.(folder) ?? folder);
  const started = performance.now();
  let error: string | undefined;
  let refused = false;
  try {
    await target.run(input, file);
  } catch (e) {
    if (target.refused(e)) refused = true;
    else error = describe(e);
  }
  const ms = performance.now() - started;
  const writes = endWrites();
  if (writes.length) return { kind: 'write', error: `wrote outside its folder: ${writes.join('; ')}`, ms };
  if (error) return { kind: 'error', error, ms };
  if (ms > budgetMs) return { kind: 'slow', error: `took ${Math.round(ms)} ms on ${input.length} bytes, past the ${budgetMs} ms budget`, refused, ms };
  return { refused, ms };
}

export interface LoopOptions {
  seed: number;
  /** The inputs start..iterations-1 run, until the deadline (Date.now()) passes. */
  start: number;
  iterations: number;
  deadline: number;
  folder: string;
  budgetMs: number;
  /** Shared with the watching thread: [0] the iteration running (-1 when none is), [1] the inputs started so far. */
  progress?: Int32Array;
  onFinding: (finding: Finding) => void;
}

const MiB = 1024 ** 2;

/**
 * Runs a target's inputs in turn. Memory is checked two ways after each input: what the process holds now against
 * what it held before the input, and its peak against the peak when the loop started; either past the target's budget
 * is a finding. The peak is the process's, so a run started after a bigger one sees less: fuzz one target to isolate.
 * An input that leaves a file open is run once more, and is a finding when it leaves one open again. Open files are
 * counted by the guard (leftOpen), so only where it is installed: in the worker.
 */
export async function loop(target: Target, o: LoopOptions): Promise<{ runs: number; refused: number; ms: number }> {
  prepare(target);
  target.setUp?.(o.folder);
  const started = performance.now();
  const budget = target.memoryMiB * MiB;
  const peakAtStart = process.resourceUsage().maxRSS * 1024;
  let peak = peakAtStart;
  let runs = 0;
  let refused = 0;
  for (let iteration = o.start; iteration < o.iterations && Date.now() < o.deadline; iteration++) {
    const input = inputFor(target, o.seed, iteration);
    const finding = (kind: FindingKind, error: string, ms: number) =>
      o.onFinding({ target: target.name, owner: target.owner, kind, seed: o.seed, iteration, ms, error });
    if (o.progress) {
      Atomics.store(o.progress, 0, iteration);
      Atomics.add(o.progress, 1, 1);
    }
    const before = process.memoryUsage.rss();
    const outcome = await runOne(target, input, o.folder, o.budgetMs);
    runs++;
    if (outcome.refused) refused++;
    if (outcome.kind) finding(outcome.kind, outcome.error ?? '', outcome.ms);
    if (leftOpen() > 0) {
      await runOne(target, input, o.folder, o.budgetMs);
      const left = leftOpen();
      if (left > 0) finding('leak', `it left ${left} file${left === 1 ? '' : 's'} open on ${input.length} bytes`, outcome.ms);
    }
    const held = process.memoryUsage.rss() - before;
    const now = process.resourceUsage().maxRSS * 1024;
    if (held > budget || (now > peak && now - peakAtStart > budget)) {
      const what = held > budget ? `it left the process holding ${Math.round(held / MiB)} MiB more` : `the process peaked ${Math.round((now - peakAtStart) / MiB)} MiB above where the run started`;
      finding('memory', `${what} on ${input.length} bytes, past the target's ${target.memoryMiB} MiB`, outcome.ms);
    }
    peak = Math.max(peak, now);
  }
  if (o.progress) Atomics.store(o.progress, 0, -1);
  return { runs, refused, ms: performance.now() - started };
}
