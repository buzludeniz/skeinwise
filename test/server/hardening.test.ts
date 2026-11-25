// Regression tests for the web server's security findings, each built from its proof of concept in the v1 audit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';
import { loadConfig, saveConfig } from '../../src/config.ts';
import { publicMessage } from '../../src/server/app.ts';
import { type Running, startServer } from '../../src/server/serve.ts';

let dir: string;
let home: string;
let scan: string;
let app: Running;

async function api(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers['X-Skeinwise-Token'] = init.token ?? app.token;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${app.port}/api/${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Sends one request line as written, with no token, and gives the status line of the answer. */
function requestLine(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(app.port, '127.0.0.1', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-hardening-'));
  home = join(dir, 'home');
  expect(await main(['demo'], { out: () => undefined, err: () => undefined, env: { SKEINWISE_HOME: home } })).toBe(0);
  // No-AI, so no test ever reaches a model server, even one running on this machine.
  saveConfig(home, { ...loadConfig(home), engine: 'none' });
  scan = join(dir, 'scan');
  mkdirSync(join(scan, 'Documents', 'Notes'), { recursive: true });
  writeFileSync(join(scan, 'Documents', 'Notes', 'one.md'), '# One\n\nA note.');
  // Files outside the scan root, and a symlink from inside it to them (web/poc/06).
  mkdirSync(join(dir, 'outside', 'private-notes'), { recursive: true });
  writeFileSync(join(dir, 'outside', 'recovery-codes.txt'), 'Recovery codes\nCANARY-a1b2c\n');
  writeFileSync(join(dir, 'outside', 'private-notes', 'bank.md'), '# Bank\n\nCANARY-hunter2\n');
  symlinkSync(join(dir, 'outside'), join(scan, 'Elsewhere'));
  app = await startServer({ home, port: 0, webDir: null, scanRoot: scan });
});

afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('M3: a request line that is no URL', () => {
  it('gets 400 before any check, and the server keeps answering (web/poc/03)', async () => {
    for (const target of ['http://[', 'http://a:b:c@[x', 'http://%']) {
      expect(await requestLine(target)).toMatch(/^HTTP\/1\.1 400 /);
    }
    expect((await api('status')).status).toBe(200);
  });
});

describe('M2: the path endpoints', () => {
  const outside = () => [
    join(dir, 'outside', 'recovery-codes.txt'),
    join(dir, 'outside', 'nope.txt'),
    join(dir, 'outside', 'private-notes'),
    join(scan, 'Elsewhere', 'recovery-codes.txt'),
    join(scan, 'missing.md'),
    '/etc/hosts',
    '/var/root',
    '/no/such/place',
    'Documents/Notes',
  ];

  it('answer one generic 403 for every path not under the scan root (web/poc/06)', async () => {
    const before = (await api('stats')).body.entries;
    const answers = new Set<string>();
    for (const path of outside()) {
      for (const route of ['found/preview', 'import']) {
        const res = await api(route, { body: { path } });
        expect(res.status, `${route} ${path}`).toBe(403);
        answers.add(JSON.stringify(res.body));
      }
    }
    expect(answers.size).toBe(1);
    expect([...answers][0]).not.toMatch(/\//);
    expect((await api('stats')).body.entries).toBe(before);
    expect((await api('search?q=CANARY&limit=10')).body.hits).toEqual([]);
  });

  it('still preview and bring in what lies under the scan root', async () => {
    const notes = join(scan, 'Documents', 'Notes');
    expect((await api('found/preview', { body: { path: notes } })).body).toMatchObject({ entries: 1 });
    const res = await api('import', { body: { path: notes } });
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ kind: 'notes', added: 1 });
  });

  it('keep paths outside the record folder out of error bodies', () => {
    const said = publicMessage(`ENOENT: no such file or directory, stat '/Users/someone/secret/codes.txt'`, home);
    expect(said).toBe(`ENOENT: no such file or directory, stat '…/codes.txt'`);
    expect(publicMessage('EACCES: permission denied, scandir /var/root.', home)).toBe('EACCES: permission denied, scandir …/root.');
    expect(publicMessage(`Can't read ${join(home, 'notes', 'a.md')}`, home)).toBe(`Can't read ${join(home, 'notes', 'a.md')}`);
    expect(publicMessage('No entry 12', home)).toBe('No entry 12');
  });
});
