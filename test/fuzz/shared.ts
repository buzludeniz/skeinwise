// The fuzz targets for code the import track uses but doesn't own: src/fsafe.ts's zip reader and src/safe-text.ts.
// A finding in either goes to the lead with its seed, unfixed.

import { deflateSync, strToU8, zipSync } from 'fflate';
import { openZipSafe, UnsafeFileError, ZIP_MAX_RATIO } from '../../src/fsafe.ts';
import { isBidiControl, safeBlock, safeJson, safeLine } from '../../src/safe-text.ts';
import { buildZip } from '../fsafe-zip.ts';
import { concat, mutateZipField, type Target } from './engine.ts';

const MiB = 1024 ** 2;

// ---- the zip reader ----

/** Caps small enough that a mutated 1 MiB input can reach every one of them. */
const ZIP_CAPS = { maxBytes: 4 * MiB, maxTotalBytes: 8 * MiB, ratioFloor: 1 * MiB };

/**
 * The reader's own refusal, or fflate's error for a damaged packed stream: a FlateError carries a numeric code (a
 * system error's code is a string). zip.read passes fflate's through; readDocx turns it into a refusal.
 */
export function zipRefused(error: unknown): boolean {
  return error instanceof UnsafeFileError || (error instanceof Error && typeof (error as { code?: unknown }).code === 'number');
}

function zipSeeds(): Uint8Array[] {
  const text = strToU8('Seed swap on Saturday. Bring beans, peas and labels.\n'.repeat(40));
  const zeros = new Uint8Array(2 * MiB);
  return [
    zipSync({ 'notes/a.txt': text, 'b.json': strToU8('{"title":"x","n":[1,2,3]}'), 'empty.txt': new Uint8Array(0) }),
    zipSync({ 'notes/a.txt': text, 'c.md': strToU8('# C\n') }, { level: 0 }),
    buildZip([{ name: 'a.txt', data: deflateSync(text), size: text.length }], { zip64: true }),
    // Says it unpacks to 100 bytes, and unpacks to 2 MiB.
    buildZip([{ name: 'lying.txt', data: deflateSync(zeros), size: 100 }]),
    // Says what it unpacks to, at about a thousand to one.
    buildZip([{ name: 'honest.txt', data: deflateSync(zeros), size: zeros.length }]),
    buildZip([
      { name: 'stored.txt', data: text, method: 0, size: text.length },
      { name: 'small.txt', data: deflateSync(strToU8('hi')), size: 2 },
    ]),
  ];
}

const zip: Target = {
  name: 'zip',
  owner: 'src/fsafe.ts',
  fileName: 'input.zip',
  memoryMiB: 256,
  seeds: zipSeeds,
  tokens: ['PK\x03\x04', 'PK\x01\x02', 'PK\x05\x06', 'PK\x06\x06', 'PK\x06\x07', '\xff\xff\xff\xff', '\xff\xff', '\x00\x00\x00\x00', '\x01\x00', '../', '/', '\x00'],
  mutate: (rng, seed, generic) => (rng() < 0.5 ? mutateZipField(rng, seed) : generic(seed)),
  run: (input, file) => {
    const z = openZipSafe(file, ZIP_CAPS);
    try {
      // What it kept is under every cap it was given.
      let declared = 0;
      let compressed = 0;
      for (const e of z.entries) {
        if (e.size > ZIP_CAPS.maxBytes) throw new Error(`kept ${e.name}, which declares ${e.size} bytes, past the ${ZIP_CAPS.maxBytes} cap`);
        declared += e.size;
        compressed += e.compressedSize;
      }
      if (declared > ZIP_CAPS.maxTotalBytes) throw new Error(`kept ${declared} declared bytes, past the ${ZIP_CAPS.maxTotalBytes} cap`);
      const packed = Math.max(1, Math.min(compressed, input.length));
      if (declared > ZIP_CAPS.ratioFloor && declared > ZIP_MAX_RATIO * packed) throw new Error(`kept ${declared} bytes from ${packed} packed, past the ratio`);
      // Every entry reads to exactly what it declared, or is refused; one refusal doesn't stop the others.
      let total = 0;
      for (const e of z.entries) {
        let data: Uint8Array;
        try {
          data = z.read(e);
        } catch (error) {
          if (zipRefused(error)) continue;
          throw error;
        }
        if (data.length !== e.size) throw new Error(`read ${data.length} bytes of ${e.name}, which declares ${e.size}`);
        total += data.length;
      }
      if (total > declared) throw new Error(`read ${total} bytes in all, more than the ${declared} declared`);
    } finally {
      z.close();
    }
  },
  refused: zipRefused,
};

// ---- safe-text ----

/** A string from the input's bytes, decoded the way its first byte picks, so C1 controls and lone surrogates come up. */
function textOf(input: Uint8Array): string {
  const body = input.subarray(1);
  switch ((input[0] ?? 0) % 3) {
    case 0:
      return new TextDecoder('utf-8').decode(body);
    case 1:
      return Buffer.from(body).toString('latin1');
    default:
      return Buffer.from(body.subarray(0, body.length & ~1)).toString('utf16le');
  }
}

const between = (c: number, low: number, high: number) => c >= low && c <= high;

/** The first character a terminal could act on, or -1. `block` keeps line feeds and tabs. */
function firstUnsafe(text: string, block: boolean): number {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && !(block && (c === 0x0a || c === 0x09))) return i;
    if (between(c, 0x7f, 0x9f) || isBidiControl(c)) return i;
  }
  return -1;
}

/**
 * Whether `out` is `input` with characters dropped, the only changes allowed being a carriage return made a line feed
 * (block) and a carriage return, line feed or tab made a space (line). Greedy matching is exact for a subsequence.
 * It compares UTF-16 units, as the scanner reads them, so a surrogate pair matches half by half.
 */
function keptFrom(input: string, out: string, block: boolean): boolean {
  let i = 0;
  for (let k = 0; k < out.length; k++) {
    const o = out[k]!;
    for (;;) {
      if (i >= input.length) return false;
      const c = input[i++]!;
      if (c === o) break;
      if (block && o === '\n' && c === '\r') break;
      if (!block && o === ' ' && (c === '\r' || c === '\n' || c === '\t')) break;
    }
  }
  return true;
}

function checkClean(name: string, clean: (t: string) => string, text: string, block: boolean): void {
  const out = clean(text);
  const at = firstUnsafe(out, block);
  if (at >= 0) throw new Error(`${name} left U+${out.charCodeAt(at).toString(16).padStart(4, '0')} at ${at}`);
  if (clean(out) !== out) throw new Error(`${name} changes its own output`);
  if (!keptFrom(text, out, block)) throw new Error(`${name} added or reordered text`);
  if (firstUnsafe(text, block) < 0 && !text.includes('\r') && out !== text) throw new Error(`${name} changed text that was already safe`);
}

const ESC = '\x1b';
const safeText: Target = {
  name: 'safe-text',
  owner: 'src/safe-text.ts',
  memoryMiB: 256,
  seeds: () => [
    concat(new Uint8Array([0]), strToU8(`Seed swap\r\n${ESC}[31mred${ESC}[0m ${ESC}]52;c;aGk=\x07 ${ESC}]8;;http://x${ESC}\\link${ESC}]8;;${ESC}\\ ‮evil‬ ‎ok\ttab`)),
    concat(new Uint8Array([1]), Uint8Array.from('a\x9b31mb\x9d0;t\x9c c\x90q\x9c d\x85e\x7ff\rg\r\nh', (c) => c.charCodeAt(0))),
    concat(new Uint8Array([2]), Buffer.from('x\uD800y⁦z⁩\x1bP1$r\x1b\\\x18\x1a', 'utf16le')),
  ],
  tokens: [`${ESC}[`, `${ESC}]`, `${ESC}P`, `${ESC}X`, `${ESC}^`, `${ESC}_`, `${ESC}\\`, `${ESC}(B`, `${ESC}7`, ESC, '\x07', '\x18', '\x1a', '\x9b', '\x9d', '\x90', '\x9c', '\x85', '\x7f', '\r', '\n', '\t', '\r\n', '\n\r', '‪', '‮', '⁦', '⁩', '‎', '؜', '52;c;', '8;;', '31m', '\uD800', '\uDC00'],
  run: (input) => {
    const text = textOf(input);
    checkClean('safeBlock', safeBlock, text, true);
    checkClean('safeLine', safeLine, text, false);
    const value = { title: text, list: [text.slice(0, 64), text.slice(-64)] };
    const json = safeJson(value);
    if (/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(json)) throw new Error('safeJson left an unsafe character');
    const back = JSON.parse(json) as typeof value;
    if (back.title !== value.title || back.list[0] !== value.list[0] || back.list[1] !== value.list[1]) throw new Error("safeJson doesn't parse back to the same value");
  },
  refused: () => false,
};

export const SHARED_TARGETS: Target[] = [zip, safeText];
