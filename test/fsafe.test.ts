import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, strToU8, zipSync } from 'fflate';
import { openSafe, openZipSafe, readRange, readSafe, readTextSafe, UnsafeFileError } from '../src/fsafe.ts';
import { buildZip } from './fsafe-zip.ts';

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

  it('opens a checked descriptor for partial reads, with the same refusals', () => {
    const path = write('session.jsonl', 'line one\nline two\n');
    const handle = openSafe(path, { root: dir });
    try {
      expect(handle.stat.size).toBe(18);
      expect(readRange(handle.fd, 8, 9).toString('utf8')).toBe('line two');
      expect(readRange(handle.fd, 100, 9).toString('utf8')).toBe('line two\n');
    } finally {
      closeSync(handle.fd);
    }
    const link = join(dir, 'session-link.jsonl');
    symlinkSync(path, link);
    expect(refused(() => openSafe(link)).reason).toBe('symlink');
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

  it('refuses a bomb entry that a stored padding entry would lift under the archive’s ratio', () => {
    // 2 MiB of padding gives the archive room for 400 MiB at 200:1; the bomb claims 300 MiB from a few dozen bytes.
    const padding = new Uint8Array(2 * MiB).fill(32);
    const path = write(
      'padded-bomb.zip',
      buildZip([
        { name: 'padding.json', data: padding, method: 0, size: padding.length },
        { name: 'conversations.json', data: deflateSync(new Uint8Array(4096)), size: 300 * MiB },
      ]),
    );
    expect(refused(() => openZipSafe(path)).message).toMatch(
      /refused, conversations\.json would unpack to \d+ times its packed size \(300 MiB\), past the 200:1 limit/,
    );
  });

  it('stops a bomb at the front of a long entry while it inflates, against the packed bytes really read', () => {
    // 16 MiB of zeros packs to about 16 KiB, but the entry claims 300 KiB of packed bytes, so the directory sees 55:1.
    // The first 64 KiB read unpacks to all 16 MiB, 256 times what was read. The floor is 1 MiB to keep the test small.
    const data = new Uint8Array(300 * 1024);
    data.set(deflateSync(new Uint8Array(16 * MiB)));
    const path = write('front-bomb.zip', buildZip([{ name: 'conversations.json', data, size: 16 * MiB }]));
    const zip = openZipSafe(path, { ratioFloor: MiB });
    expect(refused(() => zip.read(zip.entries[0]!)).message).toMatch(
      /\(conversations\.json\): refused, it unpacked to 256 times its packed size \(16 MiB so far\), past the 200:1 limit/,
    );
    zip.close();
  });

  it('refuses entries that share packed bytes, whatever padding sits beside them', () => {
    // b, c and d point at a's local header: each would read a's stream, and the padding keeps every ratio honest.
    const stream = deflateSync(new Uint8Array(64 * 1024).fill(32));
    const padding = new Uint8Array(2 * MiB).fill(32);
    const zip = buildZip([
      ...['a', 'b', 'c', 'd'].map((n) => ({ name: `${n}.json`, data: n === 'a' ? stream : new Uint8Array(0), size: 64 * 1024 })),
      { name: 'padding.json', data: padding, method: 0, size: padding.length },
    ]);
    let at = zip.readUInt32LE(zip.length - 22 + 16);
    for (const n of [0, 1, 2, 3]) {
      if (n > 0) {
        zip.writeUInt32LE(stream.length, at + 20);
        zip.writeUInt32LE(0, at + 42);
      }
      at += 46 + zip.readUInt16LE(at + 28);
    }
    const path = write('shared-bytes.zip', zip);
    expect(refused(() => openZipSafe(path)).message).toMatch(/refused, [abcd]\.json shares packed bytes with another entry/);
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

  it('stops, instead of spinning, when the zip is cut short after it was opened', () => {
    const body = deflateSync(new Uint8Array(256 * 1024).map((_, i) => (i * 7919) % 251));
    const path = write('cut.zip', buildZip([{ name: 'conversations.json', data: body, size: 256 * 1024 }]));
    const zip = openZipSafe(path);
    truncateSync(path, 40);
    expect(refused(() => zip.read(zip.entries[0]!)).message).toContain('cut short');
    zip.close();
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
