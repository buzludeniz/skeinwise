import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageError } from '../../src/errors.ts';
import { fileRequest, pendingRequests, REQUESTS_FILE } from '../../src/mcp/requests.ts';

// On Windows, a lock its holder deleted while another process still had it open stays "delete pending" until that
// handle closes, and opening it meanwhile fails with EPERM (or EACCES), not EEXIST or ENOENT. That race needs two
// processes and luck; this seam makes the lock's open or read fail that way on any OS, and process.platform says which
// OS the lock code believes it runs on.

const seam = vi.hoisted(() => ({ lock: '', code: 'EPERM', open: 0, read: 0, failed: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const busy = (syscall: string, path: unknown) => {
    seam.failed++;
    return Object.assign(new Error(`${seam.code}: operation not permitted, ${syscall} '${String(path)}'`), { code: seam.code, syscall, path: String(path) });
  };
  return {
    ...fs,
    openSync: ((path, ...rest) => {
      if (path === seam.lock && seam.open > 0) {
        seam.open--;
        throw busy('open', path);
      }
      return fs.openSync(path, ...rest);
    }) as typeof fs.openSync,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (path === seam.lock && seam.read > 0) {
        seam.read--;
        throw busy('open', path);
      }
      return (fs.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync,
  };
});

const NOW = '2026-11-26T08:00:00.000Z';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const runAs = (os: NodeJS.Platform) => Object.defineProperty(process, 'platform', { ...platform, value: os });

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-lock-busy-'));
  home = join(dir, 'home');
  seam.lock = join(home, `${REQUESTS_FILE}.lock`);
  Object.assign(seam, { code: 'EPERM', open: 0, read: 0, failed: 0 });
  mkdirSync(home);
  fileRequest(home, { agent: 'setup', tool: 'undo_run', target: 1, what: 'Undo run 1' }, NOW);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const file = (agent: string) => fileRequest(home, { agent, tool: 'undo_run', target: 2, what: 'Undo run 2' }, NOW);
const agents = () => pendingRequests(home, NOW).map((r) => r.agent);

describe("on Windows, a requests' lock that is busy being deleted", () => {
  it.each(['EPERM', 'EACCES'])('is waited out when taking it fails with %s, and the request is filed', (code) => {
    runAs('win32');
    Object.assign(seam, { code, open: 2 });
    expect(file('agent-a')).toMatchObject({ agent: 'agent-a', target: 2 });
    expect(seam.failed).toBe(2);
    expect(agents()).toEqual(['setup', 'agent-a']);
    expect(readdirSync(home)).not.toContain(`${REQUESTS_FILE}.lock`);
  });

  it("is waited out when reading a dead holder's lock fails, and the request is filed", () => {
    runAs('win32');
    // A dead holder's lock, old enough to be freed whatever its pid says. The waiter reads it to judge it, and that read
    // finds it being deleted.
    writeFileSync(seam.lock, JSON.stringify({ pid: process.pid, nonce: 'gone' }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(seam.lock, old, old);
    seam.read = 1;
    expect(file('agent-b')).toMatchObject({ agent: 'agent-b' });
    expect(seam.failed).toBe(1);
    expect(agents()).toEqual(['setup', 'agent-b']);
    expect(readdirSync(home).filter((f) => f.includes('.lock'))).toEqual([]);
  });

  it('does not fail a request already filed when the check before letting the lock go finds it being deleted', () => {
    runAs('win32');
    // The take succeeds, so the first read of the lock is the holder's own check before it deletes the lock.
    seam.read = 1;
    expect(file('agent-e')).toMatchObject({ agent: 'agent-e' });
    expect(seam.failed).toBe(1);
    expect(agents()).toEqual(['setup', 'agent-e']);
  });

  it('still gives up with the usual message when it stays busy past the wait', () => {
    runAs('win32');
    seam.open = Number.POSITIVE_INFINITY;
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
    expect(() => file('agent-c')).toThrow(UsageError);
    expect(() => file('agent-c')).toThrow(/held .*\.lock for over 5 seconds, so no agent request changed/);
    expect(agents()).toEqual(['setup']);
  });
});

describe('elsewhere, the same error from the lock', () => {
  it.each(['linux', 'darwin'] as const)('is thrown as it is on %s, and nothing is filed', (os) => {
    runAs(os);
    seam.open = 1;
    let thrown: unknown;
    try {
      file('agent-d');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeInstanceOf(UsageError);
    expect(thrown).toMatchObject({ code: 'EPERM', syscall: 'open' });
    expect(seam.failed).toBe(1);
    expect(agents()).toEqual(['setup']);
  });
});
