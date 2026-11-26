// The output sanitiser for text that arrives in pieces: a model's answer as it streams.
//
// Each piece could end partway through an escape sequence (ESC [ 3 in one piece, 1 m in the next), or on a carriage
// return whose line feed is still to come. Cleaning each piece alone would print what a whole-text clean drops, so
// the stream holds back the unfinished tail and cleans only the part before it, with the same `safeBlock` or
// `safeLine` (src/safe-text.ts). What it prints, joined, is exactly what that function prints for the whole text;
// test/safe-stream.test.ts checks that on random splits.
//
// The tail it holds starts at the first control whose meaning the next piece could still change: a carriage return
// at the end, an ESC at the end, an escape sequence with no final byte yet, or an OSC, DCS, SOS, PM or APC string
// with no terminator yet. A string that never ends is held to the end of the stream, then printed as `safeBlock`
// prints it (its introducer dropped, its text kept). A streamed answer is a few hundred tokens, so the held tail stays
// small.

import { safeBlock, safeLine } from './safe-text.ts';

const CR = 0x0d;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const ESC = 0x1b;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_STRINGS = new Set([0x9d, 0x90, 0x98, 0x9e, 0x9f]);
const ESC_CSI = 0x5b;
const ESC_STRINGS = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);

const between = (c: number, low: number, high: number) => c >= low && c <= high;

export interface SafeStream {
  /** Adds a piece; returns the clean text that is now certain (possibly empty). */
  push(piece: string): string;
  /** Ends the stream; returns the clean rest. */
  end(): string;
}

/** A stream cleaned as one block (`safeBlock`) or as one line (`safeLine`). */
export function safeStream(shape: 'block' | 'line' = 'block'): SafeStream {
  const clean = shape === 'line' ? safeLine : safeBlock;
  let held = '';
  return {
    push(piece) {
      held += piece;
      const cut = openFrom(held);
      if (cut === 0) return '';
      const out = clean(held.slice(0, cut));
      held = held.slice(cut);
      return out;
    },
    end() {
      const out = clean(held);
      held = '';
      return out;
    },
  };
}

/** Where the text's unfinished tail starts: the first control the next piece could still change, or the end. */
export function openFrom(text: string): number {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === CR) {
      if (i + 1 >= n) return i;
      i++;
    } else if (c === ESC || c === C1_CSI || C1_STRINGS.has(c)) {
      const end = sequenceEnd(text, i);
      if (end === null) return i;
      i = end;
    } else {
      i++;
    }
  }
  return n;
}

/**
 * Where the sequence that the ESC or C1 introducer at `i` opens is certain to end, or null while more text could
 * change it. It needs to be exact only about that: the cleaning itself is `safeBlock`'s.
 */
function sequenceEnd(text: string, i: number): number | null {
  const n = text.length;
  const c = text.charCodeAt(i);
  if (c === C1_CSI) return csiEnd(text, i + 1);
  if (C1_STRINGS.has(c)) return stringEnd(text, i + 1);
  if (i + 1 >= n) return null;
  const next = text.charCodeAt(i + 1);
  if (next === ESC_CSI) return csiEnd(text, i + 2);
  if (ESC_STRINGS.has(next)) return stringEnd(text, i + 2);
  if (between(next, 0x20, 0x2f)) {
    let j = i + 2;
    while (j < n && between(text.charCodeAt(j), 0x20, 0x2f)) j++;
    return j < n ? j : null;
  }
  return i + 1;
}

function csiEnd(text: string, j: number): number | null {
  const n = text.length;
  while (j < n && between(text.charCodeAt(j), 0x30, 0x3f)) j++;
  while (j < n && between(text.charCodeAt(j), 0x20, 0x2f)) j++;
  return j < n ? j : null;
}

/** A string ends at its terminator, or is cut by ESC (with the character after it known), CAN, SUB or a C1 control. */
function stringEnd(text: string, start: number): number | null {
  const n = text.length;
  for (let j = start; j < n; j++) {
    const c = text.charCodeAt(j);
    if (c === BEL || c === C1_ST) return j + 1;
    if (c === ESC) return j + 1 < n ? start : null;
    if (c === CAN || c === SUB || between(c, 0x80, 0x9f)) return start;
  }
  return null;
}
