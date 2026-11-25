// One output sanitiser for everything Skeinwise prints.
//
// Imported text (chat titles, file names, bodies) and model output reach the screen, and a terminal treats some
// characters in them as commands: OSC 52 writes the clipboard, OSC 8 hides a link behind other text, CSI 8m hides
// words, CSI 2J clears the screen, and the bidi overrides reorder what you read. These functions drop all of that,
// on a terminal and in piped output alike, so what prints is only text:
//
// - C0 controls go, except line feed and tab. A carriage return before a line feed goes; a lone one becomes a line
//   feed, so it can't send the cursor back over a line that was already printed.
// - DEL and the C1 controls (U+0080 to U+009F) go.
// - Escape sequences go whole, in their 7-bit (ESC [) and 8-bit (U+009B) forms: CSI; OSC, DCS, SOS, PM and APC
//   strings up to their terminator; the short ones such as ESC 7 and ESC ( B. A string that has no terminator loses
//   only its introducer, so its text stays on screen instead of vanishing.
// - The bidi embeddings, overrides and isolates (U+202A to U+202E, U+2066 to U+2069) go. The marks (U+200E, U+200F,
//   U+061C) stay: they can't reverse a run of text, and right-to-left writing needs them.
//
// One pass, no regular expressions: each character is read at most twice, so a hostile title can't make printing
// slow (the lesson of M6).

const LF = 0x0a;
const TAB = 0x09;
const CR = 0x0d;
const BEL = 0x07;
const CAN = 0x18;
const SUB = 0x1a;
const ESC = 0x1b;
const DEL = 0x7f;
const BACKSLASH = 0x5c;
/** The 8-bit forms: CSI, OSC, DCS, SOS, PM, APC and the string terminator. */
const C1_CSI = 0x9b;
const C1_STRINGS = new Set([0x9d, 0x90, 0x98, 0x9e, 0x9f]);
const C1_ST = 0x9c;
/** After ESC: CSI is `[`; OSC `]`, DCS `P`, SOS `X`, PM `^` and APC `_` open a string. */
const ESC_CSI = 0x5b;
const ESC_STRINGS = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);

const between = (c: number, low: number, high: number) => c >= low && c <= high;

/** The bidi embedding, override and isolate characters, the ones that can reverse a run of text. */
export function isBidiControl(c: number): boolean {
  return between(c, 0x202a, 0x202e) || between(c, 0x2066, 0x2069);
}

/** The text of a block, safe to print: line feeds and tabs kept, every other control and escape sequence dropped. */
export function safeBlock(text: string): string {
  return scan(text, false);
}

/** The text of one line, safe to print: as `safeBlock`, and line feeds and tabs become spaces. */
export function safeLine(text: string): string {
  return scan(text, true);
}

/**
 * A value as JSON whose bytes are safe to print. `JSON.stringify` already escapes C0; this also escapes DEL, C1 and
 * the bidi controls as `\uXXXX`, so the text is safe on a terminal and parses back to exactly the same value.
 */
export function safeJson(value: unknown, space?: number): string {
  const text = JSON.stringify(value, null, space) as string | undefined;
  if (text === undefined) throw new TypeError(`Can't write ${typeof value} as JSON`);
  return text.replace(/[\u007f-\u009f‪-‮⁦-⁩]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The two ways a command prints. */
export interface Printer {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** The same io with both of its printers sanitised by `safeBlock`. Wrap the io once, where commands start. */
export function safeIo<T extends Printer>(io: T): T {
  return { ...io, out: (text: string) => io.out(safeBlock(text)), err: (text: string) => io.err(safeBlock(text)) };
}

function scan(text: string, oneLine: boolean): string {
  let out = '';
  let kept = 0; // where the current run of plain text starts
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (between(c, 0x20, 0x7e) || (c > 0x9f && !isBidiControl(c))) {
      i++;
      continue;
    }
    if ((c === LF || c === TAB) && !oneLine) {
      i++;
      continue;
    }
    out += text.slice(kept, i);
    if (c === LF || c === TAB) {
      out += ' ';
      i++;
    } else if (c === CR) {
      if (text.charCodeAt(i + 1) !== LF) out += oneLine ? ' ' : '\n';
      i++;
    } else {
      i = skipControl(text, i);
    }
    kept = i;
  }
  return kept === 0 ? text : out + text.slice(kept);
}

/** Where the text resumes after the control at `i` and any escape sequence it opens. */
function skipControl(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c === C1_CSI) return skipCsi(text, i + 1);
  if (C1_STRINGS.has(c)) return skipString(text, i + 1);
  if (c !== ESC) return i + 1; // any other C0 or C1 control, DEL, or a bidi control
  if (i + 1 >= text.length) return i + 1;
  const next = text.charCodeAt(i + 1);
  if (next === ESC_CSI) return skipCsi(text, i + 2);
  if (ESC_STRINGS.has(next)) return skipString(text, i + 2);
  if (between(next, 0x20, 0x2f)) {
    // ESC, intermediates, then one final byte (ESC ( B and the like).
    let j = i + 2;
    while (j < text.length && between(text.charCodeAt(j), 0x20, 0x2f)) j++;
    return j < text.length && between(text.charCodeAt(j), 0x30, 0x7e) ? j + 1 : j;
  }
  if (between(next, 0x30, 0x7e)) return i + 2; // ESC 7, ESC c, ESC M, a stray ESC \ ...
  return i + 1; // ESC before a control or a non-ASCII character: drop the ESC, read the rest as text
}

/** A CSI's parameters, intermediates and final byte. A cut-off one is dropped up to where it stops making sense. */
function skipCsi(text: string, j: number): number {
  while (j < text.length && between(text.charCodeAt(j), 0x30, 0x3f)) j++;
  while (j < text.length && between(text.charCodeAt(j), 0x20, 0x2f)) j++;
  return j < text.length && between(text.charCodeAt(j), 0x40, 0x7e) ? j + 1 : j;
}

/**
 * An OSC, DCS, SOS, PM or APC string, from just after its introducer to its terminator (BEL, ESC \ or U+009C). One
 * that ESC, CAN, SUB or another C1 control cuts off, or that runs to the end, has no terminator: only the
 * introducer goes, and its text is read again as plain text.
 */
function skipString(text: string, start: number): number {
  for (let j = start; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === BEL || c === C1_ST) return j + 1;
    if (c === ESC) return text.charCodeAt(j + 1) === BACKSLASH ? j + 2 : start;
    if (c === CAN || c === SUB || between(c, 0x80, 0x9f)) return start;
  }
  return start;
}
