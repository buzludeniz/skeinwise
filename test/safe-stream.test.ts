// The streaming sanitiser: however a text is cut into pieces, the cleaned pieces join to exactly what safeBlock (or
// safeLine) makes of the whole text, and no piece carries a control.

import { describe, expect, it } from 'vitest';
import { openFrom, safeStream } from '../src/safe-stream.ts';
import { safeBlock, safeLine } from '../src/safe-text.ts';

/** Pieces a hostile or unlucky answer is made of: escape introducers, terminators, parameters, controls and text. */
const ALPHABET = [
  'a', 'Z', ' ', 'é', '😀', '\n', '\r', '\t', '\x1b', '[', ']', '\\', '\x07', '0', '5', ';', 'm', 'J', '(', 'B', 'P', 'X',
  '^', '_', '\x9b', '\x9d', '\x90', '\x9c', '\x18', '\x1a', '\x00', '\x7f', '‮', '⁦', '‏', ' ',
];

/** A small seeded generator, so a failure prints a case that reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

function split(text: string, pick: (n: number) => number): string[] {
  const pieces: string[] = [];
  let i = 0;
  while (i < text.length) {
    const len = 1 + pick(Math.min(6, text.length - i));
    pieces.push(text.slice(i, i + len));
    i += len;
  }
  return pieces;
}

function streamed(pieces: string[], shape: 'block' | 'line'): string[] {
  const s = safeStream(shape);
  return [...pieces.map((p) => s.push(p)), s.end()];
}

describe('safeStream', () => {
  it('holds an escape sequence cut between pieces and drops it whole', () => {
    expect(streamed(['red ', '\x1b[3', '1mwarning\x1b', '[0m done'], 'block')).toEqual(['red ', '', 'warning', ' done', '']);
    // OSC 52 would write the clipboard: never printed, however it is cut.
    expect(streamed(['copy \x1b]52;c;', 'aGk=', '\x07ok'], 'block').join('')).toBe('copy ok');
    expect(streamed(['copy \x1b]52;c;aGk=\x1b', '\\ok'], 'block').join('')).toBe('copy ok');
  });

  it('waits for the line feed after a carriage return', () => {
    expect(streamed(['one\r', '\ntwo\r', 'three'], 'block')).toEqual(['one', '\ntwo', '\nthree', '']);
    expect(streamed(['one\r', '\ntwo'], 'line').join('')).toBe('one two');
  });

  it('prints a string that never ends as safeBlock does: its introducer dropped, its text kept', () => {
    const pieces = ['before \x1b]', 'no terminator ', 'here'];
    const out = streamed(pieces, 'block');
    expect(out.slice(0, -1).join('')).toBe('before ');
    expect(out.join('')).toBe(safeBlock(pieces.join('')));
  });

  it('knows where an unfinished tail starts', () => {
    expect(openFrom('plain text')).toBe(10);
    expect(openFrom('a\r')).toBe(1);
    expect(openFrom('a\rb')).toBe(3);
    expect(openFrom('a\x1b')).toBe(1);
    expect(openFrom('a\x1b[1;3')).toBe(1);
    expect(openFrom('a\x1b[1;3mb')).toBe(8);
    expect(openFrom('a\x1b(')).toBe(1);
    expect(openFrom('a\x1b(Bb')).toBe(5);
    expect(openFrom('a\x9d8;;x')).toBe(1);
    expect(openFrom('a\x9d8;;x\x9cb')).toBe(8);
  });

  it('joins to exactly the whole text cleaned, on random texts cut at random', () => {
    const pick = rng(20261125);
    for (let round = 0; round < 3000; round++) {
      const text = Array.from({ length: pick(40) }, () => ALPHABET[pick(ALPHABET.length)]!).join('');
      const pieces = split(text, pick);
      for (const shape of ['block', 'line'] as const) {
        const out = streamed(pieces, shape);
        const whole = shape === 'line' ? safeLine(text) : safeBlock(text);
        if (out.join('') !== whole) throw new Error(`round ${round} (${shape}): ${JSON.stringify(pieces)} gave ${JSON.stringify(out)}, not ${JSON.stringify(whole)}`);
        // Every piece is already clean on its own.
        for (const piece of out) expect(shape === 'line' ? safeLine(piece) : safeBlock(piece)).toBe(piece);
      }
    }
  });

  it('cuts one character at a time as well', () => {
    const text = 'a\x1b[31mb\r\nc\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\‮d\x9b2Je\x90q\x9cf\r';
    expect(streamed([...text], 'block').join('')).toBe(safeBlock(text));
    expect(streamed([...text], 'line').join('')).toBe(safeLine(text));
  });
});
