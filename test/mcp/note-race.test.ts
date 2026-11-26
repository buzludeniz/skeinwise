import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openHome } from '../../src/home.ts';
import { appendDailyNote, readNotes, writeAgentNote } from '../../src/notes.ts';
import { isBusy, openDb } from '../../src/store/db.ts';
import { Store } from '../../src/store/store.ts';

// An agent's note save is filed under its own run even when another Skeinwise process (the app, the CLI, another
// agent's server) reads the notes folder while the agent writes. The seam below runs that other reader right after a
// read of the folder: between the agent's file write and its save, or between a reader's read and its ingest. The
// other reader is a second connection to the record with a short busy wait, standing in for another process.

const seam = vi.hoisted(() => ({ hook: null as ((dir: string) => boolean) | null }));
vi.mock('../../src/importers/detect.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/importers/detect.ts')>();
  return {
    ...real,
    readImports: (...args: Parameters<typeof real.readImports>) => {
      const read = real.readImports(...args);
      const hook = seam.hook;
      if (hook) {
        seam.hook = null;
        if (!hook(args[0])) seam.hook = hook;
      }
      return read;
    },
  };
});

const NOW = '2026-11-26T09:00:00.000Z';
let dir: string;
let home: string;
let agent: Store;
let other: Store;

const connect = () => new Store(openDb(join(home, 'record.db'), { busyTimeoutMs: 20 }), () => NOW);

/** Runs fn as the other process would: 'done', or 'busy' when the record's write lock is held. */
function attempt(fn: () => unknown): 'done' | 'busy' {
  try {
    fn();
    return 'done';
  } catch (err) {
    if (isBusy(err)) return 'busy';
    throw err;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-note-race-'));
  home = join(dir, 'home');
  openHome(home, () => NOW).db.close();
  agent = connect();
  other = connect();
});

afterEach(() => {
  seam.hook = null;
  agent.db.close();
  other.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const versions = (store: Store, entryId: number) => store.history(entryId).map((v) => [v.editor, v.runId]);

describe("another process reading the notes folder between an agent's file write and its save", () => {
  it("finds a new note already filed as the agent's run, never as yours", () => {
    const file = join(home, 'notes', 'rye-plan.md');
    let reader: 'done' | 'busy' | null = null;
    seam.hook = () => {
      if (!existsSync(file)) return false;
      reader = attempt(() => readNotes(other, home));
      return true;
    };
    const write = writeAgentNote(agent, home, 'cursor', 'Rye plan', 'Try 80% hydration.', new Date(NOW));
    // The other process waits for the agent's save; here its short wait runs out instead.
    expect(reader).toBe('busy');
    readNotes(other, home);
    expect(versions(agent, write.entryId)).toEqual([['agent:cursor', write.runId]]);
    expect(agent.getEntry(write.entryId)!.speaker).toBe('cursor');
  });

  it("finds a line added to today's note already filed as the agent's run", () => {
    const mine = appendDailyNote(agent, home, 'Fed the starter.', new Date(NOW));
    let reader: 'done' | 'busy' | null = null;
    seam.hook = () => {
      if (!readFileSync(mine.path, 'utf8').includes('cursor: Turned the oven on.')) return false;
      reader = attempt(() => readNotes(other, home));
      return true;
    };
    const write = appendDailyNote(agent, home, 'Turned the oven on.', new Date(NOW), 'cursor');
    expect(reader).toBe('busy');
    readNotes(other, home);
    expect(versions(agent, mine.entryId)).toEqual([
      ['you', null],
      ['agent:cursor', write.runId!],
    ]);
  });
});

describe('a read of the notes folder made before an agent writes', () => {
  it("is read again once the agent has saved, never putting the agent's older text back as yours", () => {
    const first = writeAgentNote(agent, home, 'cursor', 'Rye plan', 'Try 80% hydration.', new Date(NOW));
    let second: ReturnType<typeof writeAgentNote> | null = null;
    // The other process has read the folder (80%) and has yet to file it when the agent changes the note (78%).
    seam.hook = () => {
      second = writeAgentNote(agent, home, 'cursor', 'Rye plan', 'Try 78% hydration.', new Date(NOW));
      return true;
    };
    readNotes(other, home);
    expect(second).not.toBeNull();
    expect(readFileSync(first.path, 'utf8')).toContain('78%');
    readNotes(agent, home);
    expect(versions(agent, first.entryId)).toEqual([
      ['agent:cursor', first.runId],
      ['agent:cursor', second!.runId],
    ]);
  });
});
