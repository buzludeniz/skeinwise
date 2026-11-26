// Regression tests for the web server's security findings, each built from its proof of concept in the v1 audit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';
import { loadConfig, saveConfig } from '../../src/config.ts';
import { publicMessage } from '../../src/server/app.ts';
import { type Running, startServer } from '../../src/server/serve.ts';
import { sameToken } from '../../src/server/token.ts';
import { keyShaped } from '../samples.ts';
import { cleanUploads } from '../../src/server/uploads.ts';

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

/** Sends one request as written, byte for byte, and gives the status line of the answer. */
function rawRequest(target: string, headers: Buffer = Buffer.alloc(0)): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(app.port, '127.0.0.1', () => {
      socket.write(Buffer.concat([
        Buffer.from(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\nConnection: close\r\n`, 'latin1'),
        headers,
        Buffer.from('\r\n', 'latin1'),
      ]));
    });
    let data = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

const MiB = 1024 * 1024;

/** Uploads `size` zero bytes in 64 KiB writes: chunked, or with a Content-Length when `declared` is given. */
function upload(batch: string, path: string, size: number, options: { declared?: number; dropAfter?: number } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const headers: Record<string, string | number> = { 'X-Skeinwise-Token': app.token, 'Content-Type': 'application/octet-stream' };
    if (options.declared !== undefined) headers['Content-Length'] = options.declared;
    const req = request(
      { host: '127.0.0.1', port: app.port, method: 'POST', path: `/api/upload?batch=${batch}&path=${encodeURIComponent(path)}`, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', (error) => (options.dropAfter === undefined ? reject(error) : resolve({ status: 0, body: '' })));
    const chunk = Buffer.alloc(64 * 1024);
    let sent = 0;
    const write = () => {
      while (sent < size) {
        if (options.dropAfter !== undefined && sent >= options.dropAfter) {
          req.destroy();
          resolve({ status: 0, body: '' });
          return;
        }
        const n = Math.min(chunk.length, size - sent);
        sent += n;
        if (!req.write(chunk.subarray(0, n))) {
          req.once('drain', write);
          return;
        }
      }
      req.end();
    };
    write();
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
  // A 1 MiB upload cap stands in for the real 1 GiB one.
  app = await startServer({ home, port: 0, webDir: null, scanRoot: scan, uploadLimit: MiB });
});

afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('M3: a request line that is no URL', () => {
  it('gets 400 before any check, and the server keeps answering (web/poc/03)', async () => {
    for (const target of ['http://[', 'http://a:b:c@[x', 'http://%']) {
      expect(await rawRequest(target)).toMatch(/^HTTP\/1\.1 400 /);
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

describe('L10: the token check', () => {
  it('answers 401, not 500, to a 64-character token that is not ASCII (supply/09 case 4)', async () => {
    const header = Buffer.concat([Buffer.from('X-Skeinwise-Token: ', 'latin1'), Buffer.from([0xe9]), Buffer.from(`${'a'.repeat(63)}\r\n`, 'latin1')]);
    expect(await rawRequest('/api/status', header)).toMatch(/^HTTP\/1\.1 401 /);
    expect((await api('status')).status).toBe(200);
  });

  it('is a plain yes or no for any header', () => {
    const token = 'ab'.repeat(32);
    expect(sameToken(token, token)).toBe(true);
    for (const given of [undefined, '', 'é' + token.slice(1), token.slice(1), `${token}0`, '😀'.repeat(16), 'AB'.repeat(32)]) {
      expect(sameToken(given, token)).toBe(false);
    }
  });
});

describe('L9: the token per start', () => {
  it('is new each time the server starts, so an earlier URL stops working', async () => {
    const second = await startServer({ home, port: 0, webDir: null, scanRoot: scan });
    try {
      expect(second.token).not.toBe(app.token);
      expect(second.token).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(join(home, 'token'), 'utf8').trim()).toBe(second.token);
      const answer = await fetch(`http://127.0.0.1:${second.port}/api/status`, { headers: { 'X-Skeinwise-Token': app.token } });
      expect(answer.status).toBe(401);
    } finally {
      await second.close();
    }
  });

  it('stays the same with --keep-token', async () => {
    const kept = readFileSync(join(home, 'token'), 'utf8').trim();
    const third = await startServer({ home, port: 0, webDir: null, scanRoot: scan, keepToken: true });
    try {
      expect(third.token).toBe(kept);
    } finally {
      await third.close();
    }
  });
});

describe('L2: the upload cap', () => {
  const saved = (batch: string, name: string) => join(home, 'imports', batch, name);

  it('counts a chunked body: over the cap is 413 and no file stays (web/poc/07)', async () => {
    const res = await upload('pocbigchunked01', 'big.zip', MiB + 8 * 1024);
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toBe('That file is larger than 1 MB');
    expect(existsSync(saved('pocbigchunked01', 'big.zip'))).toBe(false);
    expect((await api('status')).status).toBe(200);
  });

  it('refuses a declared size over the cap', async () => {
    const res = await upload('pocbigdeclared01', 'big.zip', MiB + 1, { declared: MiB + 1 });
    expect(res.status).toBe(413);
    expect(existsSync(saved('pocbigdeclared01', 'big.zip'))).toBe(false);
  });

  it('saves a chunked body under the cap, owner-only', async () => {
    const res = await upload('smallchunked01', 'notes/small.md', MiB / 2);
    expect(res.status).toBe(200);
    const stat = statSync(saved('smallchunked01', join('notes', 'small.md')));
    expect(stat.size).toBe(MiB / 2);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('removes the partial file when the client goes away mid-upload', async () => {
    await upload('cutoffbatch01', 'half.zip', MiB / 2, { dropAfter: 128 * 1024 });
    const file = saved('cutoffbatch01', 'half.zip');
    for (let i = 0; i < 50 && existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(file)).toBe(false);
    expect((await api('status')).status).toBe(200);
  });

  it('cleans batches older than a day when the server starts', () => {
    const imports = join(dir, 'clean-home', 'imports');
    for (const name of ['oldbatch0001', 'newbatch0001', 'Not-A-Batch']) {
      mkdirSync(join(imports, name), { recursive: true });
      writeFileSync(join(imports, name, 'a.md'), 'x');
    }
    const dayAndHourAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(join(imports, 'oldbatch0001'), dayAndHourAgo, dayAndHourAgo);
    utimesSync(join(imports, 'Not-A-Batch'), dayAndHourAgo, dayAndHourAgo);
    expect(cleanUploads(join(dir, 'clean-home'))).toBe(1);
    expect(existsSync(join(imports, 'oldbatch0001'))).toBe(false);
    expect(existsSync(join(imports, 'newbatch0001'))).toBe(true);
    expect(existsSync(join(imports, 'Not-A-Batch'))).toBe(true);
    expect(cleanUploads(join(dir, 'no-such-home'))).toBe(0);
  });
});

describe('L8: note files', () => {
  const notes = () => join(home, 'notes');
  const outside = (name: string) => join(dir, 'outside', name);

  it('never writes through a link at the next note\'s name, and new notes are owner-only (web/poc/09)', async () => {
    mkdirSync(notes(), { recursive: true });
    symlinkSync(outside('created-by-skeinwise.txt'), join(notes(), 'planted.md'));
    const res = await api('notes', { body: { title: 'Planted', body: 'written through a symlink?' } });
    expect(res.status).toBe(200);
    expect(existsSync(outside('created-by-skeinwise.txt'))).toBe(false);
    expect(readFileSync(join(notes(), 'planted-2.md'), 'utf8')).toContain('written through a symlink?');
    expect(statSync(join(notes(), 'planted-2.md')).mode & 0o777).toBe(0o600);
    rmSync(join(notes(), 'planted.md'));
  });

  it('refuses to save an entry whose file was swapped for a link, and keeps the version as it was', async () => {
    writeFileSync(outside('victim.txt'), 'ORIGINAL CONTENT OF A FILE OUTSIDE THE RECORD\n');
    const { id } = (await api('notes', { body: { title: 'Swap', body: 'before' } })).body;
    rmSync(join(notes(), 'swap.md'));
    symlinkSync(outside('victim.txt'), join(notes(), 'swap.md'));
    const res = await api(`entries/${id}`, { method: 'PUT', body: { body: 'OVERWRITTEN BY PUT /api/entries' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("notes/swap.md is a symbolic link, so Skeinwise won't read through it");
    expect(readFileSync(outside('victim.txt'), 'utf8')).toBe('ORIGINAL CONTENT OF A FILE OUTSIDE THE RECORD\n');
    expect((await api(`entries/${id}`)).body.entry.body).toContain('before');
    rmSync(join(notes(), 'swap.md'));
  });

  it('won\'t write the daily note into a folder that leads outside notes/', async () => {
    rmSync(join(notes(), 'daily'), { recursive: true, force: true });
    mkdirSync(outside('daily-elsewhere'));
    symlinkSync(outside('daily-elsewhere'), join(notes(), 'daily'));
    const res = await api('daily', { body: { text: 'a daily line' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('notes/daily leads outside notes/');
    expect(readdirOf(outside('daily-elsewhere'))).toEqual([]);
    rmSync(join(notes(), 'daily'));
    expect((await api('daily', { body: { text: 'a daily line' } })).status).toBe(200);
    expect(lstatSync(join(notes(), 'daily')).isDirectory()).toBe(true);
  });
});

describe('M11 / SETTINGS-1: the page cannot choose where your words go', () => {
  it('refuses a settings change that sends them elsewhere, with the command and none of the values sent', async () => {
    const before = (await api('settings')).body;
    const tries = [
      { ai: { engine: 'remote' } },
      { ai: { remote: { address: 'https://collector.attacker.invalid/v1' } } },
      { ai: { remote: { hosts: ['collector.attacker.invalid'] } } },
      { ai: { remote: { keyEnv: 'SKEINWISE_STOLEN_API_KEY' } } },
      { exclusions: { redact: false } },
      { live: { folders: [{ path: '/Users/someone/.ssh' }] } },
      { live: { remote: true } },
      { live: { downloads: true } },
    ];
    for (const body of tries) {
      const res = await api('settings', { method: 'PUT', body: { appearance: { theme: 'paper' }, ...body } });
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body.command).toMatch(/^skeinwise config \w+ /);
      expect(JSON.stringify(res.body)).not.toMatch(/attacker|STOLEN|\.ssh/);
    }
    expect((await api('settings')).body).toEqual(before);
    // What the page was shown goes back unchanged.
    expect((await api('settings', { method: 'PUT', body: { ai: before.ai, live: before.live, exclusions: before.exclusions } })).status).toBe(200);
  });

  it('never lets a request pick the outside model the terminal did not choose', async () => {
    let reached = 0;
    const outside = createServer((req, res) => {
      reached++;
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"choices":[{"message":{"content":"{}"}}],"usage":{}}');
    });
    await new Promise<void>((done) => outside.listen(0, '127.0.0.1', done));
    const port = (outside.address() as { port: number }).port;
    const saved = loadConfig(home);
    process.env.SKEINWISE_HARDENING_API_KEY = keyShaped('sk-', 'hardening-', 'not-a-real-key');
    saveConfig(home, { ...saved, engine: 'local', remoteUrl: `http://127.0.0.1:${port}/v1`, remoteModel: 'm', apiKeyEnv: 'SKEINWISE_HARDENING_API_KEY', remoteHosts: [`127.0.0.1:${port}`] });
    try {
      const ask = await api('ask?q=One&engine=remote');
      expect(ask.status).toBe(403);
      expect(ask.body.command).toBe('skeinwise config engine remote');
      expect((await api('organise/preview', { body: { task: 'tag', engine: 'remote' } })).status).toBe(403);
      expect((await api('organise', { body: { task: 'tag', engine: 'remote', yes: true } })).status).toBe(403);
      expect(reached).toBe(0);
      // Once the terminal chose it, the same request reaches it: the refusal above is what stopped it.
      saveConfig(home, { ...loadConfig(home), engine: 'remote' });
      expect((await api('ask?q=One&engine=remote')).status).toBe(200);
      expect(reached).toBeGreaterThan(0);
    } finally {
      saveConfig(home, saved);
      delete process.env.SKEINWISE_HARDENING_API_KEY;
      await new Promise((done) => outside.close(done));
    }
  });
});

describe('L7: the screen lock', () => {
  it('is still on after a restart (web/poc/10)', async () => {
    expect((await api('lock', { body: {} })).body).toEqual({ locked: true });
    const again = await startServer({ home, port: 0, webDir: null, scanRoot: scan, keepToken: true });
    const call = (path: string, method = 'GET') =>
      fetch(`http://127.0.0.1:${again.port}/api/${path}`, {
        method,
        headers: { 'X-Skeinwise-Token': again.token, 'Content-Type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      });
    try {
      expect(((await (await call('status')).json()) as any).locked).toBe(true);
      expect((await call('search?q=One')).status).toBe(423);
      expect((await call('entries/1')).status).toBe(423);
      expect(((await (await call('unlock', 'POST')).json()) as any).locked).toBe(false);
      expect((await call('search?q=One')).status).toBe(200);
    } finally {
      await again.close();
    }
    expect((await api('unlock', { body: {} })).body).toEqual({ locked: false });
    const third = await startServer({ home, port: 0, webDir: null, scanRoot: scan, keepToken: true });
    try {
      const status = await fetch(`http://127.0.0.1:${third.port}/api/status`, { headers: { 'X-Skeinwise-Token': third.token } });
      expect(((await status.json()) as any).locked).toBe(false);
    } finally {
      await third.close();
    }
  });
});

function readdirOf(path: string): string[] {
  return existsSync(path) ? readdirSync(path) : [];
}
