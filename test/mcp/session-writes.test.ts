import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowAgent } from '../../src/mcp/access.ts';
import { memoryServer } from '../../src/mcp/commands.ts';
import { MAX_SESSION_BYTES } from '../../src/mcp/frame.ts';
import { LOG_FILE } from '../../src/mcp/log.ts';
import { MemorySession, WRITE_ROOM } from '../../src/mcp/session.ts';
import { listRuns } from '../../src/organiser/runs.ts';
import type { Store } from '../../src/store/store.ts';
import { call, context, demoRecord, initialize } from './helpers.ts';

// A change an agent's tool has made is never reported to it as refused or failed: it would ask again, and the change
// would be made twice. So a writing tool is refused before it runs when the session can't take its result, and a log
// that can't be written after the change doesn't take the result away.

const NOW = '2026-11-26T08:00:00.000Z';
let dir: string;
let home: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-mcp-writes-'));
  home = join(dir, 'home');
  store = demoRecord(dir, home);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const noteRuns = () => listRuns(store.db).filter((r) => r.task === 'note').length;

function session(): MemorySession {
  const token = allowAgent(home, 'cursor', NOW, 'write').token;
  return new MemorySession({ store, home, token, now: () => NOW });
}

const run = (s: MemorySession, name: string, args: Record<string, unknown>) => s.tools.find((t) => t.name === name)!.run({ label: 'cursor' }, args);

describe('a writing tool near the end of a session', () => {
  it("is refused before it runs when the session can't take its result, so nothing is written", async () => {
    const s = session();
    s.served = MAX_SESSION_BYTES - 100;
    const before = noteRuns();
    await expect(run(s, 'append_daily_note', { text: 'Fed the starter.' })).rejects.toThrow(/This session has had 500 KB of the record/);
    await expect(run(s, 'write_note', { title: 'Plan', body: 'Bake on Sunday.' })).rejects.toThrow(/This session has had 500 KB of the record/);
    expect(noteRuns()).toBe(before);
  });

  it('runs, and its result goes out, while the session has room for it', async () => {
    const s = session();
    s.served = MAX_SESSION_BYTES - WRITE_ROOM;
    const before = noteRuns();
    expect(await run(s, 'append_daily_note', { text: 'Fed the starter.' })).toContain('"run_id"');
    expect(noteRuns()).toBe(before + 1);
  });
});

describe('a writing tool whose call the log refuses', () => {
  it('still gives the agent its result, and tells the person the log failed', async () => {
    const token = allowAgent(home, 'cursor', NOW, 'write').token;
    const { ctx, output } = context(home, store, { now: () => NOW, token });
    const s = memoryServer(ctx);
    await initialize(s, 'cursor');
    // A folder where the log file should be: appending fails.
    mkdirSync(join(home, LOG_FILE));
    const before = noteRuns();

    const res = await call(s, 'append_daily_note', { text: 'Fed the starter.' });
    expect(res.isError).toBe(false);
    expect(noteRuns()).toBe(before + 1);
    expect(res.json).toMatchObject({ run_id: expect.any(Number), log_error: expect.stringContaining('mcp-log.jsonl: EISDIR') });
    expect(res.text).not.toContain('sent no result');
    expect(output.err).toContain('append_daily_note');
    expect(output.err).toContain("couldn't write its MCP log (mcp-log.jsonl: EISDIR)");

    // A read still sends nothing it can't log.
    const read = await call(s, 'search', { query: 'starter' });
    expect(read.isError).toBe(true);
    expect(read.text).toBe("Skeinwise couldn't write its MCP log (mcp-log.jsonl: EISDIR), so it sent no result.");
  });
});
