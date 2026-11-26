import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setConfigValue } from '../src/config.ts';
import { connect, type SetupCtx } from '../src/connect.ts';
import { type DoctorDeps, diagnose, doctor, type Finding } from '../src/doctor.ts';
import { denyAgent, setLocked } from '../src/mcp/access.ts';
import { ensureServerKey } from '../src/model-commands.ts';
import { demoRecord } from './mcp/helpers.ts';
import { posixModes } from './modes.ts';

// `skeinwise doctor` (LS-12) on a throwaway HOME and record. The model server is a fake fetch: nothing here opens a
// connection, and the record's settings point at a port nobody serves, so even a real fetch would reach nothing.

const NOW = '2026-11-25T10:00:00.000Z';
const MODEL_URL = 'http://127.0.0.1:9/v1';

let dir: string;
let user: string;
let home: string;
let asked: { url: string; auth: string | null }[];
let answer: () => Response;

const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  asked.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
  return answer();
}) as typeof fetch;

const env = () => ({ HOME: user, SKEINWISE_HOME: home, PATH: '/usr/bin:/bin' });
// The platform is a POSIX one only where the file system has POSIX modes: on Windows every file reports 0666, so doctor
// gives its Windows note there, and the tests about modes alone run on macOS and Linux.
const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({ nodeVersion: '24.11.0', platform: posixModes ? 'darwin' : 'win32', fetch: fakeFetch, ...over });
const problems = (findings: Finding[]) => findings.filter((f) => f.status === 'problem');
const of = (findings: Finding[], check: Finding['check']) => findings.filter((f) => f.check === check);

function ctxFor(values: SetupCtx['values'] = {}) {
  const output = { out: '', json: [] as unknown[] };
  const ctx: SetupCtx = { io: { out: (t) => (output.out += t), err: () => {}, env: env(), now: () => NOW, fetch: fakeFetch }, home, values, args: [], json: (v) => output.json.push(v) };
  return { ctx, output };
}

/** Makes every file the record holds owner-only, as setup leaves a record. */
function tidy(): void {
  for (const name of ['record.db', 'record.db-wal', 'record.db-shm', 'config.json', 'agents.json']) {
    if (existsSync(join(home, name))) chmodSync(join(home, name), 0o600);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-doctor-'));
  user = join(dir, 'user');
  home = join(dir, 'record');
  mkdirSync(user);
  asked = [];
  answer = () => Response.json({ data: [{ id: 'qwen3-4b' }] });
  demoRecord(dir, home).db.close();
  setConfigValue(home, 'localUrl', MODEL_URL);
  tidy();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('skeinwise doctor', () => {
  it('passes a healthy setup and asks the model server for its models once', async () => {
    mkdirSync(join(user, '.cursor'));
    await connect({ ...ctxFor({ yes: true }).ctx, args: ['cursor'] }, { script: resolve('src/cli.ts'), node: process.execPath });
    ensureServerKey(home);
    writeFileSync(join(home, 'live.json'), JSON.stringify({ lastSavedAt: NOW, lastPassAt: NOW, caught: [], errors: [] }), { mode: 0o600 });
    tidy();

    const findings = await diagnose(home, env(), deps());
    expect(problems(findings)).toEqual([]);
    expect(of(findings, 'mcp')).toEqual([{ check: 'mcp', status: 'ok', text: 'Cursor is connected as cursor (read scope)' }]);
    expect(asked).toEqual([{ url: `${MODEL_URL}/models`, auth: expect.stringMatching(/^Bearer \S+$/) }]);

    const { ctx, output } = ctxFor();
    expect(await doctor(ctx, deps())).toBe(0);
    expect(output.out).toContain('  ok       Node 24.11.0\n');
    expect(output.out).toContain(`Model server at ${MODEL_URL}: qwen3-4b`);
    expect(output.out).toContain('Everything Skeinwise needs is in place.');
  });

  it.runIf(posixModes)('names both problems on a broken setup: record.db at mode 0644 and no Node 24', async () => {
    chmodSync(join(home, 'record.db'), 0o644);
    const { ctx, output } = ctxFor();
    expect(await doctor(ctx, deps({ nodeVersion: '22.12.0' }))).toBe(1);
    expect(output.out).toContain('problem  Node 22.12.0 is older than Skeinwise needs (Node 24 or newer).');
    expect(output.out).toContain('Fix: Install Node 24 or newer from https://nodejs.org/');
    expect(output.out).toContain('problem  Other people on this computer can read record.db (mode 0644).');
    expect(output.out).toContain(`Fix: chmod 600 '${join(home, 'record.db')}'`);
    expect(output.out).toContain('2 problems, each with its fix above.');
  });

  it('flags an open record folder, and leaves file modes alone on Windows', async () => {
    chmodSync(home, 0o755);
    if (posixModes) expect(problems(await diagnose(home, env(), deps())).map((f) => f.fix)).toEqual([`chmod 700 '${home}'`]);
    expect(of(await diagnose(home, env(), deps({ platform: 'win32' })), 'modes')).toEqual([
      { check: 'modes', status: 'note', text: "Who may read the record folder isn't checked on Windows yet." },
    ]);
  });

  it("says there is no record yet, and doesn't make one", async () => {
    rmSync(home, { recursive: true });
    const findings = await diagnose(home, env(), deps());
    expect(of(findings, 'record')).toEqual([{ check: 'record', status: 'problem', text: `There is no record at ${home} yet.`, fix: 'Bring in your chats and notes: skeinwise setup' }]);
    expect(existsSync(home)).toBe(false);
  });

  it('names a record written by a newer Skeinwise', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(home, 'record.db'));
    db.exec('PRAGMA user_version = 9999');
    db.close();
    expect(of(await diagnose(home, env(), deps()), 'record')[0]).toMatchObject({ status: 'problem', fix: 'Update Skeinwise: npm install -g skeinwise@1' });
    writeFileSync(join(home, 'record.db'), 'not a database, just text that is long enough to fill a header and then some more.');
    expect(of(await diagnose(home, env(), deps()), 'record')[0]!.text).toMatch(/isn't an SQLite database/);
  });

  it('leaves no file behind in the record folder', async () => {
    const before = readdirSync(home).sort();
    await diagnose(home, env(), deps());
    expect(readdirSync(home).sort()).toEqual(before);
  });

  it('checks the model server: down, refusing the key, missing the model, or no model at all', async () => {
    answer = () => {
      throw new TypeError('fetch failed');
    };
    expect(of(await diagnose(home, env(), deps()), 'model')[0]).toMatchObject({ status: 'problem', text: `No model server answers at ${MODEL_URL}.` });

    answer = () => new Response('', { status: 401 });
    expect(of(await diagnose(home, env(), deps()), 'model')[0]!.text).toMatch(/refuses Skeinwise's key/);

    answer = () => Response.json({ data: [{ id: 'other' }] });
    setConfigValue(home, 'localModel', 'qwen3-4b');
    expect(of(await diagnose(home, env(), deps()), 'model')[0]).toMatchObject({ status: 'problem', fix: 'skeinwise config localModel <name>' });

    asked = [];
    setConfigValue(home, 'engine', 'none');
    expect(of(await diagnose(home, env(), deps()), 'model')[0]!.status).toBe('ok');
    expect(asked).toEqual([]);
  });

  it("checks agent configs: a taken-back token, a lock, a command that's gone, a broken file, another record", async () => {
    mkdirSync(join(user, '.cursor'));
    await connect({ ...ctxFor({ yes: true }).ctx, args: ['cursor'] }, { script: resolve('src/cli.ts'), node: process.execPath });
    denyAgent(home, 'cursor');
    setLocked(home, true);
    let mcp = of(await diagnose(home, env(), deps()), 'mcp');
    expect(mcp).toContainEqual({ check: 'mcp', status: 'note', text: 'Agent tools are locked: every agent call is refused.', fix: 'skeinwise mcp unlock' });
    expect(mcp).toContainEqual(expect.objectContaining({ status: 'problem', text: "Cursor's token isn't one this record knows (taken back, or replaced by a later connect).", fix: 'skeinwise connect cursor' }));

    const file = join(user, '.cursor', 'mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { skeinwise: { command: join(dir, 'gone', 'skeinwise'), env: { SKEINWISE_HOME: home } } } }));
    mcp = of(await diagnose(home, env(), deps()), 'mcp');
    expect(mcp).toContainEqual(expect.objectContaining({ status: 'problem', text: expect.stringMatching(/^Cursor starts Skeinwise with .*gone.*, which isn't there\.$/) }));

    writeFileSync(file, JSON.stringify({ mcpServers: { skeinwise: { command: process.execPath, env: { SKEINWISE_HOME: home } } } }));
    expect(of(await diagnose(home, env(), deps()), 'mcp')).toContainEqual(expect.objectContaining({ status: 'problem', text: expect.stringMatching(/has no SKEINWISE_AGENT_TOKEN/) }));

    writeFileSync(file, JSON.stringify({ mcpServers: { skeinwise: { command: process.execPath, env: { SKEINWISE_HOME: join(dir, 'elsewhere') } } } }));
    expect(of(await diagnose(home, env(), deps()), 'mcp')).toContainEqual(expect.objectContaining({ status: 'note', text: expect.stringMatching(/serves another record/) }));

    writeFileSync(file, '{oops');
    expect(of(await diagnose(home, env(), deps()), 'mcp')).toContainEqual(expect.objectContaining({ status: 'problem', text: expect.stringMatching(/isn't valid JSON/) }));
  });

  it('finds a bare command on PATH as Windows does: as an .exe or a .cmd', async () => {
    mkdirSync(join(user, '.cursor'));
    await connect({ ...ctxFor({ yes: true }).ctx, args: ['cursor'] }, { script: resolve('src/cli.ts'), node: process.execPath });
    const file = join(user, '.cursor', 'mcp.json');
    const entry = JSON.parse(readFileSync(file, 'utf8')).mcpServers.skeinwise;
    writeFileSync(file, JSON.stringify({ mcpServers: { skeinwise: { ...entry, command: 'skeinwise' } } }));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const onPath = { ...env(), PATH: bin };
    const missing = expect.objectContaining({ status: 'problem', text: "Cursor starts Skeinwise with skeinwise, which isn't there." });
    expect(of(await diagnose(home, onPath, deps({ platform: 'win32' })), 'mcp')).toContainEqual(missing);
    for (const name of ['skeinwise.exe', 'skeinwise.cmd']) {
      writeFileSync(join(bin, name), '');
      chmodSync(join(bin, name), 0o755);
      expect(of(await diagnose(home, onPath, deps({ platform: 'win32' })), 'mcp')).toEqual([{ check: 'mcp', status: 'ok', text: 'Cursor is connected as cursor (read scope)' }]);
      // Only Windows adds an extension to a bare name.
      expect(of(await diagnose(home, onPath, deps({ platform: 'linux' })), 'mcp')).toContainEqual(missing);
      rmSync(join(bin, name));
    }
  });

  it("reads Codex's token from its config.toml", async () => {
    mkdirSync(join(user, '.codex'));
    await connect({ ...ctxFor({ yes: true }).ctx, args: ['codex'] }, { script: resolve('src/cli.ts'), node: process.execPath });
    expect(of(await diagnose(home, env(), deps()), 'mcp')).toEqual([{ check: 'mcp', status: 'ok', text: 'Codex is connected as codex (read scope)' }]);
  });

  it('notes when no agent is connected, and names a broken agents.json', async () => {
    expect(of(await diagnose(home, env(), deps()), 'mcp')).toEqual([
      { check: 'mcp', status: 'note', text: 'No agent is set up to use this record as its memory.', fix: 'skeinwise connect claude-code (or codex, cursor, claude-desktop)' },
    ]);
    writeFileSync(join(home, 'agents.json'), '{nope', { mode: 0o600 });
    expect(of(await diagnose(home, env(), deps()), 'mcp')[0]).toMatchObject({ status: 'problem', text: expect.stringMatching(/^agents\.json can't be read/) });
  });

  it("names live capture's trouble: an unreadable live.json, or files it couldn't bring in", async () => {
    expect(of(await diagnose(home, env(), deps()), 'live')[0]!.status).toBe('note');
    writeFileSync(join(home, 'live.json'), '{', { mode: 0o600 });
    expect(of(await diagnose(home, env(), deps()), 'live')[0]).toMatchObject({ status: 'problem', text: expect.stringMatching(/^live\.json in the record folder can't be read/) });
    writeFileSync(join(home, 'live.json'), JSON.stringify({ lastPassAt: NOW, errors: [{ path: '/x/broken.jsonl', error: 'Unexpected end of JSON input' }] }));
    expect(of(await diagnose(home, env(), deps()), 'live')[0]).toMatchObject({ status: 'problem', fix: "See the whole error: skeinwise import '/x/broken.jsonl'" });
  });

  it.runIf(posixModes)('answers --json', async () => {
    chmodSync(join(home, 'record.db'), 0o644);
    const { ctx, output } = ctxFor({ json: true });
    expect(await doctor(ctx, deps())).toBe(1);
    expect(output.out).toBe('');
    expect(output.json[0]).toMatchObject({ home, problems: 1, findings: expect.arrayContaining([expect.objectContaining({ check: 'modes', status: 'problem' })]) });
  });
});
