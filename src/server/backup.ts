import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';

/** Writes a zip of the record (a consistent copy of record.db, the notes and config.json) into home/backups. */
export function backup(home: string, db: DatabaseSync, now = new Date()): { file: string; bytes: number } {
  const dir = join(home, 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const copy = join(dir, `.record-${stamp}.db`);
  rmSync(copy, { force: true });
  db.prepare('VACUUM INTO ?').run(copy);
  const files: Record<string, Uint8Array> = {};
  try {
    files['record.db'] = new Uint8Array(readFileSync(copy));
  } finally {
    rmSync(copy, { force: true });
  }
  const notes = join(home, 'notes');
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) visit(full);
      else if (e.isFile()) files[relative(home, full).replaceAll('\\', '/')] = new Uint8Array(readFileSync(full));
    }
  };
  if (statSync(notes, { throwIfNoEntry: false })?.isDirectory()) visit(notes);
  const config = join(home, 'config.json');
  if (statSync(config, { throwIfNoEntry: false })?.isFile()) files['config.json'] = new Uint8Array(readFileSync(config));
  const zip = zipSync(files, { level: 6 });
  const file = join(dir, `skeinwise-${stamp}.zip`);
  writeFileSync(file, zip, { mode: 0o600 });
  return { file, bytes: zip.byteLength };
}
