// Text Skeinwise didn't write (notes, .txt files, and the XML inside a .docx), decoded the way its bytes say rather
// than assumed to be UTF-8:
//
// - A byte order mark picks the encoding (UTF-8, UTF-16 or UTF-32, either byte order) and is dropped, so a BOM before
//   a note's `---` no longer hides its front matter.
// - Without one, UTF-16 is recognised by its zero bytes (Notepad and PowerShell write it); anything else is UTF-8.
// - Bytes that aren't valid in that encoding become U+FFFD, and the result says so. Nothing throws on bad bytes.
// - A NUL in the first 8,000 bytes means a binary file under a text name (git's rule): it is refused, by name. A NUL
//   further on becomes U+FFFD.
// - Note files are capped at TEXT_MAX_BYTES before anything is read.

import { extname } from 'node:path';
import { readSafe, UnsafeFileError, type SafeFile, type SafeOptions, type SafeZip, type ZipEntry } from '../fsafe.ts';

/** The most bytes one note or text file may hold. A 16 MiB note is a book; anything past it isn't a note. */
export const TEXT_MAX_BYTES = 16 * 1024 ** 2;

/** Extensions read as notes, and capped at TEXT_MAX_BYTES. */
export const TEXT_NOTE_EXT: ReadonlySet<string> = new Set(['.md', '.markdown', '.txt']);

/** How far a NUL means binary (git looks at the same 8,000 bytes). */
const BINARY_SNIFF = 8000;
/** How much of a file without a BOM is looked at to tell UTF-16 from UTF-8. */
const UTF16_SNIFF = 4096;

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32le' | 'utf-32be';

export interface DecodedText {
  text: string;
  encoding: TextEncoding;
  /** The file opened with a byte order mark (now dropped). */
  bom: boolean;
  /** Some bytes weren't valid in the encoding and were replaced with U+FFFD. */
  replaced: boolean;
}

function bomOf(b: Uint8Array): { encoding: TextEncoding; length: number } | null {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { encoding: 'utf-8', length: 3 };
  // UTF-32LE's mark starts with UTF-16LE's, so it is checked first.
  if (b[0] === 0xff && b[1] === 0xfe && b[2] === 0 && b[3] === 0) return { encoding: 'utf-32le', length: 4 };
  if (b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff) return { encoding: 'utf-32be', length: 4 };
  if (b[0] === 0xff && b[1] === 0xfe) return { encoding: 'utf-16le', length: 2 };
  if (b[0] === 0xfe && b[1] === 0xff) return { encoding: 'utf-16be', length: 2 };
  return null;
}

/**
 * UTF-16 without a mark: text that is mostly ASCII has a zero in every other byte, on the high side of each pair.
 * Text with no ASCII at all (UTF-16 Chinese, say) can't be told apart this way and is read as UTF-8, with replacements.
 */
function sniffUtf16(b: Uint8Array): TextEncoding | null {
  const pairs = Math.floor(Math.min(b.length, UTF16_SNIFF) / 2);
  if (pairs < 2) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < pairs; i++) {
    if (b[2 * i] === 0) evenZeros++;
    if (b[2 * i + 1] === 0) oddZeros++;
  }
  if (oddZeros >= pairs * 0.3 && evenZeros <= pairs * 0.05) return 'utf-16le';
  if (evenZeros >= pairs * 0.3 && oddZeros <= pairs * 0.05) return 'utf-16be';
  return null;
}

function decodeWith(encoding: 'utf-8' | 'utf-16le' | 'utf-16be', bytes: Uint8Array): { text: string; replaced: boolean } {
  try {
    return { text: new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes), replaced: false };
  } catch {
    return { text: new TextDecoder(encoding, { fatal: false, ignoreBOM: true }).decode(bytes), replaced: true };
  }
}

/** TextDecoder has no UTF-32: four bytes to a code point, anything out of range (or a surrogate) is U+FFFD. */
function decodeUtf32(bytes: Uint8Array, littleEndian: boolean): { text: string; replaced: boolean } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const whole = Math.floor(bytes.length / 4);
  let replaced = bytes.length % 4 !== 0;
  const parts: string[] = [];
  const chunk: number[] = [];
  for (let i = 0; i < whole; i++) {
    let cp = view.getUint32(i * 4, littleEndian);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      cp = 0xfffd;
      replaced = true;
    }
    chunk.push(cp);
    if (chunk.length === 8192) {
      parts.push(String.fromCodePoint(...chunk));
      chunk.length = 0;
    }
  }
  if (chunk.length) parts.push(String.fromCodePoint(...chunk));
  if (bytes.length % 4 !== 0) parts.push('\ufffd');
  return { text: parts.join(''), replaced };
}

/**
 * Decodes a file's bytes as text. `label` names the file in the error a binary file gets (an UnsafeFileError, so an
 * importer skips that file alone and says why).
 */
export function decodeText(bytes: Uint8Array, label: string): DecodedText {
  const bom = bomOf(bytes);
  const encoding = bom?.encoding ?? sniffUtf16(bytes) ?? 'utf-8';
  const body = bom ? bytes.subarray(bom.length) : bytes;
  const decoded =
    encoding === 'utf-32le' || encoding === 'utf-32be' ? decodeUtf32(body, encoding === 'utf-32le') : decodeWith(encoding, body);
  let { text, replaced } = decoded;
  const nul = text.indexOf('\0');
  if (nul >= 0) {
    // Measured in characters, which for UTF-8 text is at most the byte count: never later than git's 8,000 bytes.
    if (nul < BINARY_SNIFF) throw new UnsafeFileError(label, 'not-a-file', `${label}: skipped, it holds binary data, not text`);
    text = text.replaceAll('\0', '\ufffd');
    replaced = true;
  }
  return { text, encoding, bom: bom !== null, replaced };
}

export interface ImportFile extends DecodedText {
  path: string;
  sha256: string;
  mtime: Date;
}

/**
 * Reads one text file through the safe reader and decodes it. A note (.md, .markdown, .txt) is refused past
 * TEXT_MAX_BYTES, or `options.maxBytes` when it is smaller; any other file keeps the reader's own limit.
 */
export function readTextFile(path: string, options: SafeOptions = {}): ImportFile {
  const file: SafeFile = readSafe(path, { ...options, maxBytes: capFor(path, options.maxBytes) });
  return { ...decodeText(file.bytes, file.path), path: file.path, sha256: file.sha256, mtime: file.mtime };
}

function capFor(name: string, asked: number | undefined): number | undefined {
  if (!TEXT_NOTE_EXT.has(extname(name).toLowerCase())) return asked;
  return Math.min(asked ?? TEXT_MAX_BYTES, TEXT_MAX_BYTES);
}

/**
 * The text of a file inside a zip. A note's declared size is checked against TEXT_MAX_BYTES before it is inflated;
 * the zip reader then counts the bytes it really produces against that declared size.
 */
export function readZipText(zip: SafeZip, entry: ZipEntry): string {
  const label = `${zip.path} (${entry.name})`;
  const cap = capFor(entry.name, undefined);
  if (cap !== undefined && entry.size > cap) {
    throw new UnsafeFileError(label, 'too-big', `${label}: skipped, it holds ${mib(entry.size)}, more than the ${mib(cap)} limit`);
  }
  return decodeText(zip.read(entry), label).text;
}

function mib(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`;
}
