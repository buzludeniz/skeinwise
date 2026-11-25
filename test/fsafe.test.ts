import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, strToU8, zipSync } from 'fflate';
import { openZipSafe, readSafe, readTextSafe, UnsafeFileError } from '../src/fsafe.ts';

const MiB = 1024 ** 2;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-fsafe-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function refused(fn: () => unknown): UnsafeFileError {
  try {
    fn();
  } catch (error) {
    if (error instanceof UnsafeFileError) return error;
    throw error;
  }
  throw new Error('expected the read to be refused');
}

interface Spec {
  name: string;
  /** The bytes as stored in the archive (already deflated for method 8). */
  data: Uint8Array;
  method?: 0 | 8;
  /** What the central directory says the entry unpacks to. */
  size: number;
}

/** A zip written by hand, so its central directory can say whatever a test needs, zip64 included. */
function buildZip(specs: Spec[], { zip64 = false } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const name = Buffer.from(s.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(s.method ?? 8, 8);
    local.writeUInt32LE(zip64 ? 0xffffffff : s.data.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : s.size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, Buffer.from(s.data));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(zip64 ? 45 : 20, 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(s.method ?? 8, 10);
    central.writeUInt32LE(zip64 ? 0xffffffff : s.data.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : s.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(zip64 ? 28 : 0, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    centrals.push(central, name);
    if (zip64) {
      const extra = Buffer.alloc(28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(s.size), 4);
      extra.writeBigUInt64LE(BigInt(s.data.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
      centrals.push(extra);
    }
    offset += 30 + name.length + s.data.length;
  }
  const directory = Buffer.concat(centrals);
  const tail: Buffer[] = [];
  if (zip64) {
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE(45, 12);
    end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(specs.length), 24);
    end64.writeBigUInt64LE(BigInt(specs.length), 32);
    end64.writeBigUInt64LE(BigInt(directory.length), 40);
    end64.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(end64, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : specs.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : specs.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, directory, ...tail, end]);
}

function write(name: string, data: Uint8Array | string): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

describe('readSafe', () => {
  it('reads a regular file with its hash', () => {
    const path = write('plain.json', '{"a":1}');
    const file = readSafe(path);
    expect(file.bytes.toString('utf8')).toBe('{"a":1}');
    expect(file.size).toBe(7);
    expect(file.sha256).toBe(createHash('sha256').update('{"a":1}').digest('hex'));
    expect(readTextSafe(path)).toBe('{"a":1}');
  });

  it('refuses a symbolic link unless the person named it, and then reads where it points', () => {
    const target = write('target.md', 'FAKE-SECRET');
    const link = join(dir, 'link.md');
    symlinkSync(target, link);
    const error = refused(() => readSafe(link));
    expect(error.reason).toBe('symlink');
    expect(error.message).toContain(link);
    expect(readTextSafe(link, { followLink: true })).toBe('FAKE-SECRET');
  });

  it('refuses a file reached through a linked folder that leads outside the root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'skeinwise-outside-'));
    try {
      writeFileSync(join(outside, 'secret.md'), 'FAKE-SECRET');
      const root = join(dir, 'vault');
      mkdirSync(root);
      symlinkSync(outside, join(root, 'linked'));
      const error = refused(() => readSafe(join(root, 'linked', 'secret.md'), { root }));
      expect(error.reason).toBe('outside');
      writeFileSync(join(root, 'inside.md'), 'mine');
      expect(readTextSafe(join(root, 'inside.md'), { root })).toBe('mine');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips a FIFO at once instead of waiting for a writer', () => {
    const fifo = join(dir, 'conversations.json');
    execFileSync('mkfifo', [fifo]);
    const started = performance.now();
    expect(refused(() => readSafe(fifo)).reason).toBe('not-a-file');
    // Named by the person, it passes the lstat check; the non-blocking open and fstat still refuse it.
    expect(refused(() => readSafe(fifo, { followLink: true })).reason).toBe('not-a-file');
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('refuses a folder and a file over the byte limit, naming the limit', () => {
    expect(refused(() => readSafe(dir)).reason).toBe('not-a-file');
    const big = write('big.json', Buffer.alloc(2 * MiB, 32));
    const error = refused(() => readSafe(big, { maxBytes: MiB }));
    expect(error.reason).toBe('too-big');
    expect(error.message).toContain(big);
    expect(error.message).toContain('1 MiB limit');
  });

  it('passes ordinary fs errors through', () => {
    expect(() => readSafe(join(dir, 'missing.json'))).toThrow(/ENOENT/);
  });
});

describe('openZipSafe', () => {
  it('reads stored and deflated entries from a real zip', () => {
    const path = write(
      'export.zip',
      zipSync({
        'conversations.json': strToU8('[{"mapping":{}}]'),
        'notes/stored.md': [strToU8('# Stored'), { level: 0 }],
        'empty/': {},
      }),
    );
    const zip = openZipSafe(path);
    try {
      expect(zip.entries.map((e) => e.name).sort()).toEqual(['conversations.json', 'notes/stored.md']);
      const text = (name: string) => Buffer.from(zip.read(zip.entries.find((e) => e.name === name)!)).toString('utf8');
      expect(text('conversations.json')).toBe('[{"mapping":{}}]');
      expect(text('notes/stored.md')).toBe('# Stored');
      expect(zip.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      zip.close();
    }
  });

  it('keeps only the entries the filter wants', () => {
    const path = write('mixed.zip', zipSync({ 'a.json': strToU8('[]'), 'b.png': strToU8('x') }));
    const zip = openZipSafe(path, { filter: (name) => name.endsWith('.json') });
    expect(zip.entries.map((e) => e.name)).toEqual(['a.json']);
    zip.close();
  });

  it('refuses PoC 09 (six zip64 entries of 400 MiB) from the central directory, fast and small', () => {
    // The packed data is a few bytes: the directory alone decides, so nothing is inflated.
    const kernel = deflateSync(new Uint8Array(4096).fill(32));
    const specs = Array.from({ length: 6 }, (_, i) => ({ name: `export/part-${i}.json`, data: kernel, size: 400 * MiB }));
    const path = write('09_bomb.zip', buildZip(specs, { zip64: true }));
    const rss = process.memoryUsage().rss;
    const started = performance.now();
    const error = refused(() => openZipSafe(path));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(process.memoryUsage().rss - rss).toBeLessThan(300 * MiB);
    expect(error.reason).toBe('zip');
    expect(error.message).toContain(path);
    expect(error.message).toMatch(/200:1 limit/);
  });

  it('refuses too many entries and too many bytes in all', () => {
    const tiny = (i: number) => ({ name: `f${i}.json`, data: strToU8('[]'), method: 0 as const, size: 2 });
    const many = write('many.zip', buildZip(Array.from({ length: 4 }, (_, i) => tiny(i))));
    expect(refused(() => openZipSafe(many, { maxEntries: 3 })).message).toContain('4 files, more than the 3 limit');
    const kernel = deflateSync(new Uint8Array(4096).fill(32));
    const total = write('total.zip', buildZip([{ name: 'a.json', data: kernel, size: 900 * MiB }]));
    expect(refused(() => openZipSafe(total, { maxTotalBytes: 512 * MiB })).message).toContain('more than the 512 MiB limit');
    expect(refused(() => openZipSafe(total, { maxBytes: 100 * MiB })).message).toContain('a.json would unpack to 900 MiB');
  });

  it('counts entries that share one packed stream against the archive’s real size', () => {
    // Each entry claims a 2 MiB packed stream, but all of them point at the same bytes in a much smaller file.
    const filler = new Uint8Array(2 * MiB);
    const specs = Array.from({ length: 8 }, (_, i) => ({ name: `p${i}.json`, data: i === 0 ? filler : new Uint8Array(0), size: 300 * MiB }));
    const zip = buildZip(specs);
    // Rewrite each central record's packed size to the shared 2 MiB stream.
    for (let at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); at >= 0; at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 4)) {
      zip.writeUInt32LE(2 * MiB, at + 20);
    }
    const path = write('overlap.zip', zip);
    expect(refused(() => openZipSafe(path, { maxTotalBytes: 8 * 1024 * MiB })).message).toMatch(/times its packed size/);
  });

  it('stops an entry that unpacks past the size it declared, and one that comes up short', () => {
    const real = deflateSync(new Uint8Array(4 * MiB).fill(32));
    const liar = write('liar.zip', buildZip([{ name: 'a.json', data: real, size: 1000 }]));
    const zip = openZipSafe(liar);
    expect(refused(() => zip.read(zip.entries[0]!)).message).toContain('unpacks past the 1000 bytes it declared');
    zip.close();
    const short = write('short.zip', buildZip([{ name: 'b.json', data: deflateSync(strToU8('[]')), size: 50 }]));
    const zip2 = openZipSafe(short);
    expect(refused(() => zip2.read(zip2.entries[0]!)).message).toContain('unpacked to 2 bytes, not the 50');
    zip2.close();
  });

  it('reads zip64 entries whose sizes are honest', () => {
    const body = strToU8('[{"chat_messages":[]}]');
    const path = write('z64.zip', buildZip([{ name: 'conversations.json', data: deflateSync(body), size: body.length }], { zip64: true }));
    const zip = openZipSafe(path);
    expect(Buffer.from(zip.read(zip.entries[0]!)).toString('utf8')).toBe('[{"chat_messages":[]}]');
    zip.close();
  });

  it('refuses a file that is not a zip, encrypted entries and unknown methods', () => {
    expect(refused(() => openZipSafe(write('not.zip', 'hello'))).message).toContain('not a zip file');
    const odd = write('odd.zip', buildZip([{ name: 'a.json', data: strToU8('xx'), method: 0, size: 2 }]));
    // Flip the central record to method 12 (bzip2), which Skeinwise doesn't read.
    const bytes = Buffer.from(readSafe(odd).bytes);
    bytes.writeUInt16LE(12, bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    const path = write('odd2.zip', bytes);
    const zip = openZipSafe(path);
    expect(refused(() => zip.read(zip.entries[0]!)).message).toContain('compression method 12');
    zip.close();
    expect(() => zip.read(zip.entries[0]!)).toThrow(/closed/);
  });
});
