// One reader for files Skeinwise didn't write: exports, agent histories, notes in watched folders, Downloads and
// uploads. Every importer, live capture and the web server read through it, so a link, a FIFO, a device file or a zip
// bomb is refused in one place, with a message that names the file and the limit it broke.
//
// - A symbolic link is refused unless the person named that path themself (followLink), and even then only the path
//   itself: nothing inside a folder is followed. The open uses O_NOFOLLOW, so a link swapped in after the check fails.
// - The open uses O_NONBLOCK and the open file must be a regular file, so a FIFO can't hang the process.
// - With a root, the file's real path must sit inside the root's real path, and must be the file that was opened.
// - Files and zip entries are capped in bytes. A zip is read through its central directory first: too many entries, too
//   many bytes declared in all, or a ratio past ZIP_MAX_RATIO (over the archive, or over any entry) refuse it before
//   anything is inflated. Inflation counts the bytes it really produces, stops at the size the entry declared, and
//   stops when they pass ZIP_MAX_RATIO times the packed bytes really read, by more than ZIP_RATIO_FLOOR in all.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { Inflate } from 'fflate';

export const DEFAULT_MAX_FILE_BYTES = 1024 ** 3;
export const ZIP_MAX_ENTRIES = 20_000;
export const ZIP_MAX_TOTAL_BYTES = 4 * 1024 ** 3;
export const ZIP_MAX_RATIO = 200;
/** Below this many declared bytes a zip can't hurt, whatever its ratio (small text compresses very well). */
const ZIP_RATIO_FLOOR = 64 * 1024 ** 2;
/** The central directory of 20,000 entries with long names fits easily; anything larger is not an export. */
const ZIP_MAX_DIRECTORY_BYTES = 64 * 1024 ** 2;
/** Compressed bytes pushed into the inflater at a time: deflate's ratio is at most about 1032:1, so one push can't
 * produce more than about 66 MB past a limit before the count sees it. */
const INFLATE_CHUNK = 64 * 1024;
const READ_CHUNK = 1024 * 1024;

// Windows has neither flag; there the lstat check before opening stands in for O_NOFOLLOW.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;

export type UnsafeReason = 'symlink' | 'not-a-file' | 'outside' | 'too-big' | 'zip';

/** A file Skeinwise won't read. The message names the file and why; the caller skips it and goes on. */
export class UnsafeFileError extends Error {
  readonly path: string;
  readonly reason: UnsafeReason;

  constructor(path: string, reason: UnsafeReason, message: string) {
    super(message);
    this.name = 'UnsafeFileError';
    this.path = path;
    this.reason = reason;
  }
}

export interface SafeOptions {
  /** The folder the file must sit inside, once links in the folders above it are resolved. */
  root?: string;
  /** Follow a symbolic link at the path itself. Only for a path the person named; never for a file found in a folder. */
  followLink?: boolean;
  /** The most bytes one file (or one zip entry) may hold. Default 1 GiB. */
  maxBytes?: number;
}

export interface SafeFile {
  path: string;
  bytes: Buffer;
  size: number;
  mtime: Date;
  sha256: string;
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function mib(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MiB`;
}

export interface SafeHandle {
  /** The open descriptor, read-only. The caller closes it (closeSync) when done. */
  fd: number;
  /** fstat of the open descriptor, not of the path. */
  stat: Stats;
  abs: string;
}

/**
 * Opens a file for reading after every check above, for callers that read part of a file (a tail, a fingerprint at an
 * offset). The caller closes the descriptor; readRange reads from it.
 */
export function openSafe(path: string, options: SafeOptions = {}): SafeHandle {
  const abs = resolve(path);
  if (!options.followLink) {
    const link = lstatSync(abs);
    if (link.isSymbolicLink()) throw new UnsafeFileError(abs, 'symlink', `${abs}: skipped, it is a symbolic link`);
    if (!link.isFile()) throw new UnsafeFileError(abs, 'not-a-file', `${abs}: skipped, it is not a regular file`);
  }
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | O_NONBLOCK | (options.followLink ? 0 : O_NOFOLLOW));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ELOOP on macOS and Linux, EMLINK on FreeBSD: the last part of the path became a link after the lstat.
    if (code === 'ELOOP' || code === 'EMLINK') throw new UnsafeFileError(abs, 'symlink', `${abs}: skipped, it is a symbolic link`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new UnsafeFileError(abs, 'not-a-file', `${abs}: skipped, it is not a regular file`);
    if (options.root !== undefined) {
      const real = realpathSync(abs);
      if (!isInside(realpathSync(options.root), real)) {
        throw new UnsafeFileError(abs, 'outside', `${abs}: skipped, it leads outside ${options.root}`);
      }
      // The real path must still be the file that was opened, or a folder above it was swapped for a link meanwhile.
      const again = statSync(real);
      if (again.dev !== stat.dev || again.ino !== stat.ino) {
        throw new UnsafeFileError(abs, 'outside', `${abs}: skipped, it changed while it was being read`);
      }
    }
    const max = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (stat.size > max) {
      throw new UnsafeFileError(abs, 'too-big', `${abs}: skipped, it holds ${mib(stat.size)}, more than the ${mib(max)} limit`);
    }
    return { fd, stat, abs };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Reads at most `length` bytes from `position` of an open descriptor; fewer only at the end of the file. */
export function readRange(fd: number, length: number, position: number): Buffer {
  return readAt(fd, length, position);
}

function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return done === length ? buf : buf.subarray(0, done);
}

/** Reads a whole file through the checks. Throws UnsafeFileError when it is refused, or the usual fs error. */
export function readSafe(path: string, options: SafeOptions = {}): SafeFile {
  const { fd, stat, abs } = openSafe(path, options);
  try {
    // The size from the open file: a file that grows meanwhile is read as it was, never past the limit.
    const bytes = readAt(fd, stat.size, 0);
    return { path: abs, bytes, size: bytes.length, mtime: stat.mtime, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    closeSync(fd);
  }
}

/** A file's text (UTF-8) through the checks. */
export function readTextSafe(path: string, options: SafeOptions = {}): string {
  return readSafe(path, options).bytes.toString('utf8');
}

// ---------- Zips ----------

export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflate; anything else is skipped. */
  method: number;
  encrypted: boolean;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export interface SafeZip {
  path: string;
  size: number;
  mtime: Date;
  sha256: string;
  /** The entries `filter` kept, as the central directory lists them. */
  entries: ZipEntry[];
  /** Inflates one entry, counting real bytes against what it declared. */
  read(entry: ZipEntry): Uint8Array;
  close(): void;
}

export interface ZipOptions extends SafeOptions {
  /** The entries worth inflating. Only these count toward the totals and the ratio. Default: every entry. */
  filter?: (name: string) => boolean;
  maxEntries?: number;
  maxTotalBytes?: number;
  maxRatio?: number;
  /** Bytes a zip may unpack past the ratio before it is refused. Default ZIP_RATIO_FLOOR. */
  ratioFloor?: number;
}

function zipError(path: string, why: string): UnsafeFileError {
  return new UnsafeFileError(path, 'zip', `${path}: refused, ${why}`);
}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function u64(buf: Buffer, at: number): number {
  return Number(buf.readBigUInt64LE(at));
}

/** Where the central directory is and how many entries it says it holds. */
function findDirectory(fd: number, size: number, path: string): { count: number; offset: number; length: number } {
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = readAt(fd, tailLength, size - tailLength);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw zipError(path, 'it is not a zip file (no central directory)');
  let count = tail.readUInt16LE(at + 10);
  let length = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);
  if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) {
    // Zip64: the locator sits just before the end record and points at the 64-bit end record.
    const locatorAt = size - tailLength + at - 20;
    if (locatorAt < 0) throw zipError(path, 'its zip64 end record is missing');
    const locator = readAt(fd, 20, locatorAt);
    if (locator.readUInt32LE(0) !== EOCD64_LOCATOR) throw zipError(path, 'its zip64 end record is missing');
    const endAt = u64(locator, 8);
    if (endAt + 56 > size) throw zipError(path, 'its zip64 end record points past the end of the file');
    const end = readAt(fd, 56, endAt);
    if (end.readUInt32LE(0) !== EOCD64) throw zipError(path, 'its zip64 end record is damaged');
    count = u64(end, 32);
    length = u64(end, 40);
    offset = u64(end, 48);
  }
  if (offset + length > size) throw zipError(path, 'its central directory points past the end of the file');
  return { count, offset, length };
}

function parseDirectory(dir: Buffer, count: number, path: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== CENTRAL) throw zipError(path, 'its central directory is damaged');
    const flags = dir.readUInt16LE(p + 8);
    const method = dir.readUInt16LE(p + 10);
    let compressedSize = dir.readUInt32LE(p + 20);
    let size = dir.readUInt32LE(p + 24);
    const nameLength = dir.readUInt16LE(p + 28);
    const extraLength = dir.readUInt16LE(p + 30);
    const commentLength = dir.readUInt16LE(p + 32);
    let localOffset = dir.readUInt32LE(p + 42);
    const nameStart = p + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > dir.length) throw zipError(path, 'its central directory is damaged');
    const name = dir.toString(flags & 0x800 ? 'utf8' : 'latin1', nameStart, extraStart);
    // Zip64 sizes and offset live in extra field 0x0001, in this order, only for the fields set to all ones.
    for (let e = extraStart; e + 4 <= extraStart + extraLength; ) {
      const id = dir.readUInt16LE(e);
      const len = dir.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        const end = q + len;
        if (size === 0xffffffff && q + 8 <= end) (size = u64(dir, q)), (q += 8);
        if (compressedSize === 0xffffffff && q + 8 <= end) (compressedSize = u64(dir, q)), (q += 8);
        if (localOffset === 0xffffffff && q + 8 <= end) localOffset = u64(dir, q);
      }
      e += 4 + len;
    }
    entries.push({ name, method, encrypted: (flags & 1) === 1, compressedSize, size, localOffset });
    p = next;
  }
  return entries;
}

/**
 * Opens a zip through the checks and refuses it before inflating anything when its central directory declares too
 * many entries, too many bytes in all, or a ratio no export has. Close it when done.
 */
export function openZipSafe(path: string, options: ZipOptions = {}): SafeZip {
  const { fd, stat, abs } = openSafe(path, options);
  try {
    const maxEntries = options.maxEntries ?? ZIP_MAX_ENTRIES;
    const maxTotal = options.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES;
    const maxRatio = options.maxRatio ?? ZIP_MAX_RATIO;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
    const floor = options.ratioFloor ?? ZIP_RATIO_FLOOR;
    const where = findDirectory(fd, stat.size, abs);
    if (where.count > maxEntries) throw zipError(abs, `it holds ${where.count} files, more than the ${maxEntries} limit`);
    if (where.length > ZIP_MAX_DIRECTORY_BYTES) throw zipError(abs, `its list of files takes ${mib(where.length)}`);
    const all = parseDirectory(readAt(fd, where.length, where.offset), where.count, abs);
    const filter = options.filter ?? (() => true);
    const entries = all.filter((e) => !e.name.endsWith('/') && filter(e.name));
    let declared = 0;
    let compressed = 0;
    for (const e of entries) {
      if (e.size > maxBytes) throw zipError(abs, `${e.name} would unpack to ${mib(e.size)}, more than the ${mib(maxBytes)} limit`);
      declared += e.size;
      compressed += e.compressedSize;
    }
    if (declared > maxTotal) throw zipError(abs, `it would unpack to ${mib(declared)}, more than the ${mib(maxTotal)} limit`);
    // Against the archive's real size too: entries that share one packed stream each claim its full length.
    const packed = Math.max(1, Math.min(compressed, stat.size));
    if (declared > floor && declared > maxRatio * packed) {
      const ratio = Math.round(declared / packed);
      throw zipError(abs, `it would unpack to ${ratio} times its packed size (${mib(declared)}), past the ${maxRatio}:1 limit`);
    }
    // Each entry against its own packed size as well, so a stored padding entry can't lift a bomb beside it under the
    // archive's ratio. What the entries unpack past the ratio is added up, so many small bombs don't each get a floor.
    let past = 0;
    let worst: ZipEntry | undefined;
    let worstOver = 0;
    for (const e of entries) {
      const over = e.size - maxRatio * Math.max(1, e.compressedSize);
      if (over <= 0) continue;
      past += over;
      if (over > worstOver) [worst, worstOver] = [e, over];
    }
    if (worst && past > floor) {
      const ratio = Math.round(worst.size / Math.max(1, worst.compressedSize));
      throw zipError(abs, `${worst.name} would unpack to ${ratio} times its packed size (${mib(worst.size)}), past the ${maxRatio}:1 limit`);
    }
    // No two entries share packed bytes: each ends before the next local header, or the list of files, starts. Without
    // this, entries that all read one small stream count it once each, and unread padding props up the archive's ratio.
    const ends = new Map<ZipEntry, number>();
    const byOffset = [...all].sort((a, b) => a.localOffset - b.localOffset);
    for (const [i, e] of byOffset.entries()) {
      const end = Math.min(byOffset[i + 1]?.localOffset ?? stat.size, e.localOffset < where.offset ? where.offset : stat.size);
      if (e.localOffset + 30 + e.compressedSize > end) throw zipError(abs, `${e.name} shares packed bytes with another entry`);
      ends.set(e, end);
    }
    // The hash of the archive as it is on disk, read a chunk at a time.
    const hash = createHash('sha256');
    for (let at = 0; at < stat.size; at += READ_CHUNK) hash.update(readAt(fd, Math.min(READ_CHUNK, stat.size - at), at));
    let open = true;
    const limits: InflateLimits = { maxRatio, floor, past: 0 };
    return {
      path: abs,
      size: stat.size,
      mtime: stat.mtime,
      sha256: hash.digest('hex'),
      entries,
      read: (entry) => {
        if (!open) throw new Error(`${abs} is closed`);
        const end = ends.get(entry);
        if (end === undefined) throw new Error(`${entry.name} is not an entry of ${abs}`);
        return inflateEntry(fd, end, entry, abs, limits);
      },
      close: () => {
        if (open) closeSync(fd);
        open = false;
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** The ratio as inflation measures it, shared by the reads of one zip: `past` is what earlier entries unpacked past it. */
interface InflateLimits {
  maxRatio: number;
  floor: number;
  past: number;
}

/**
 * Inflates one entry, reading only its own packed bytes (up to `end`). It stops at the size the entry declared (itself
 * under the per-file limit), and when the bytes it has produced pass `maxRatio` times the packed bytes read so far by
 * more than the floor, counting what earlier entries of the zip went past, so a bomb at the front of a long entry stops
 * after a chunk or two instead of unpacking in full.
 */
function inflateEntry(fd: number, end: number, entry: ZipEntry, path: string, limits: InflateLimits): Uint8Array {
  const label = `${path} (${entry.name})`;
  if (entry.encrypted) throw zipError(label, 'it is encrypted');
  if (entry.method !== 0 && entry.method !== 8) throw zipError(label, `it uses compression method ${entry.method}`);
  const head = readAt(fd, 30, entry.localOffset);
  if (head.length < 30 || head.readUInt32LE(0) !== LOCAL) throw zipError(label, 'its local header is damaged');
  const dataAt = entry.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  // `end` is where the next entry, the list of files or the file itself starts, so no entry reads another's bytes.
  if (dataAt + entry.compressedSize > end) throw zipError(label, 'its packed bytes run into another entry or past the end of the file');
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw zipError(label, 'its stored size and declared size differ');
    return readAt(fd, entry.size, dataAt);
  }
  const out = new Uint8Array(entry.size);
  let produced = 0;
  let read = 0;
  let peak = 0;
  const inflater = new Inflate((chunk) => {
    if (produced + chunk.length > entry.size) throw zipError(label, `it unpacks past the ${entry.size} bytes it declared`);
    out.set(chunk, produced);
    produced += chunk.length;
    peak = Math.max(peak, produced - limits.maxRatio * read);
    if (peak > 0 && limits.past + peak > limits.floor) {
      const ratio = Math.round(produced / Math.max(1, read));
      throw zipError(label, `it unpacked to ${ratio} times its packed size (${mib(produced)} so far), past the ${limits.maxRatio}:1 limit`);
    }
  });
  try {
    while (read < entry.compressedSize) {
      const length = Math.min(INFLATE_CHUNK, entry.compressedSize - read);
      const chunk = readAt(fd, length, dataAt + read);
      // The file was cut short after it was opened: without this the loop would wait forever for bytes that never come.
      if (!chunk.length) throw zipError(label, 'it was cut short while it was being read');
      read += chunk.length;
      inflater.push(chunk, read >= entry.compressedSize);
    }
  } finally {
    limits.past += peak;
  }
  if (produced !== entry.size) throw zipError(label, `it unpacked to ${produced} bytes, not the ${entry.size} it declared`);
  return out;
}
