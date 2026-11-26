// L5: a live.json cut off half way stopped live ("Unexpected end of JSON input", no pass ran). Built from the audit's
// PoC 19: a first pass writes live.json, the file is truncated, and a second pass must still run.

import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.ts';
import { openHome } from '../../src/home.ts';
import { loadStatus, readStatus, writeStatus } from '../../src/live/capture.ts';

const line = (type: 'user' | 'assistant', i: number, text: string) =>
  JSON.stringify({
    type,
    sessionId: 's1',
    uuid: `u${i}`,
    timestamp: `2026-11-20T10:0${i}:00.000Z`,
    message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
  }) + '\n';

let dir: string;
let home: string;
let userHome: string;
let session: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-status-'));
  home = join(dir, 'home');
  userHome = join(dir, 'me');
  const project = join(userHome, '.claude', 'projects', '-home-me-code');
  mkdirSync(project, { recursive: true });
  session = join(project, 's1.jsonl');
  writeFileSync(session, line('user', 1, 'Shall we keep the allotment rota on paper?') + line('assistant', 2, 'Paper, pinned to the shed door.'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function liveOnce(): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(['live', '--once'], {
    out: (t) => (out += t),
    err: (t) => (err += t),
    env: { SKEINWISE_HOME: home, HOME: userHome },
  });
  return { code, out, err };
}

describe('live.json', () => {
  it('cut off half way is moved aside with one warning, and the pass still runs (PoC 19)', async () => {
    expect((await liveOnce()).code).toBe(0);
    const file = join(home, 'live.json');
    const whole = readFileSync(file, 'utf8');
    const torn = whole.slice(0, Math.floor(whole.length / 2)); // a write cut off half way, as PoC 19 does
    writeFileSync(file, torn);
    appendFileSync(session, line('user', 3, 'Add a column for the water butt.'));

    const second = await liveOnce();
    expect(second.code).toBe(0);
    expect(second.err.match(/live\.json couldn't be read/g)).toHaveLength(1);
    expect(second.err).toMatch(/moved to live\.json\.bad-\d{4}-\d\d-\d\dT[\d-]+Z and live starts afresh/);
    const aside = readdirSync(home).filter((f) => f.startsWith('live.json.bad-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(home, aside[0]!), 'utf8')).toBe(torn);
    expect(readStatus(file).lastPassAt).not.toBeNull();

    const store = openHome(home);
    try {
      expect(store.search('water butt')).toHaveLength(1);
      expect(store.allEntries()).toHaveLength(3); // the catch-up read the session again and saved nothing twice
    } finally {
      store.db.close();
    }
  });

  it('holding anything but a status object counts as unreadable', () => {
    const file = join(dir, 'live.json');
    for (const text of ['null', '[]', '"saved"', '{"lastPassAt": "2026-11-25T10:00:00.000Z"']) {
      writeFileSync(file, text);
      const warnings: string[] = [];
      expect(loadStatus(file, (l) => warnings.push(l))).toEqual({ lastSavedAt: null, lastPassAt: null, caught: [], errors: [] });
      expect(warnings).toHaveLength(1);
      for (const f of readdirSync(dir).filter((f) => f.startsWith('live.json.bad-'))) rmSync(join(dir, f));
    }
  });

  it('is written whole: through a temporary file renamed over it', () => {
    const file = join(dir, 'live.json');
    writeFileSync(file, '{"lastPassAt": "old"}');
    const status = { lastSavedAt: null, lastPassAt: '2026-11-25T10:00:00.000Z', caught: [], errors: [] };
    writeStatus(file, status);
    expect(readStatus(file)).toEqual(status);
    expect(readdirSync(dir).filter((f) => f.startsWith('live.json.'))).toEqual([]);
  });
});
