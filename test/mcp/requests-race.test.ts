import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsageError } from '../../src/errors.ts';
import { fileRequest, pendingRequests, refuseRequest, REQUESTS_FILE } from '../../src/mcp/requests.ts';

// Agent requests are filed, confirmed and dropped by separate processes (one MCP server per agent, the CLI, the app).
// They take turns through a lock held across the file's read and write, so no two requests share an id and none is lost.

const NOW = '2026-11-26T08:00:00.000Z';
const FILERS = 4;
const EACH = 25;

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-requests-'));
  home = join(dir, 'home');
  mkdirSync(home);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Files `EACH` requests as agent `agent` from a Node process of its own, starting at `startAt` (epoch ms). */
function fileInProcess(agent: string, startAt: number): Promise<{ code: number | null; out: string }> {
  const script = `
    const [module, home, agent, startAt, each, now] = process.argv.slice(1);
    const { fileRequest } = await import(module);
    while (Date.now() < Number(startAt)) {}
    for (let n = 1; n <= Number(each); n++) {
      fileRequest(home, { agent, tool: 'undo_run', target: n, what: 'Undo run ' + n }, now);
    }
  `;
  const module = new URL('../../src/mcp/requests.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, module, home, agent, String(startAt), String(EACH), NOW], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
}

/** A pid no process has: a child's, once it has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('close', resolve));
  return child.pid!;
}

describe('agent requests filed by several processes at once', () => {
  it('get different ids, and every request is kept', async () => {
    const startAt = Date.now() + 1500;
    const runs = await Promise.all(Array.from({ length: FILERS }, (_, k) => fileInProcess(`agent-${k}`, startAt)));
    for (const run of runs) expect(run, run.out).toMatchObject({ code: 0 });

    const kept = pendingRequests(home, NOW);
    expect(kept).toHaveLength(FILERS * EACH);
    expect(new Set(kept.map((r) => r.id)).size).toBe(FILERS * EACH);
    expect(new Set(kept.map((r) => `${r.agent}/${r.target}`)).size).toBe(FILERS * EACH);
    // No lock or temporary file is left behind.
    expect(readdirSync(home)).toEqual([REQUESTS_FILE]);
  }, 60_000);
});

describe("the requests' lock", () => {
  const lock = () => join(home, `${REQUESTS_FILE}.lock`);

  it('is freed when the process holding it has died', async () => {
    writeFileSync(lock(), JSON.stringify({ pid: await deadPid(), nonce: 'dead' }), { mode: 0o600 });
    expect(fileRequest(home, { agent: 'cursor', tool: 'not_mine', target: 4, what: 'Leave out thread 4' }, NOW).id).toBe(1);
    expect(refuseRequest(home, 1, NOW).target).toBe(4);
    expect(readdirSync(home)).toEqual([REQUESTS_FILE]);
  });

  it('is never taken through a link planted at its name', () => {
    const target = join(dir, 'lock-written-here');
    symlinkSync(target, lock());
    expect(() => fileRequest(home, { agent: 'cursor', tool: 'not_mine', target: 4, what: 'Leave out thread 4' }, NOW)).toThrow(UsageError);
    expect(() => fileRequest(home, { agent: 'cursor', tool: 'not_mine', target: 4, what: 'Leave out thread 4' }, NOW)).toThrow(/is a link/);
    expect(existsSync(target)).toBe(false);
  });

  it("writes the list under a temporary name of its own, so a link at the old fixed name isn't followed", () => {
    const target = join(dir, 'requests-written-here');
    symlinkSync(target, join(home, `${REQUESTS_FILE}.tmp`));
    fileRequest(home, { agent: 'cursor', tool: 'not_mine', target: 4, what: 'Leave out thread 4' }, NOW);
    expect(existsSync(target)).toBe(false);
    expect(pendingRequests(home, NOW)).toHaveLength(1);
  });
});
