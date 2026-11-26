import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowAgent } from '../../src/mcp/access.ts';
import { windowServer } from '../../src/mcp/commands.ts';
import type { McpServer } from '../../src/mcp/protocol.ts';
import type { WindowCtx } from '../../src/mcp/window.ts';
import { type RunOptions, runSteps, steps } from '../../src/organiser/organise.ts';
import { RecordView } from '../../src/organiser/record.ts';
import { liveHubs } from '../../src/organiser/views.ts';
import type { Store } from '../../src/store/store.ts';
import { call, context, demoRecord, initialize, rpc } from './helpers.ts';

// The window tools against a fake app: it records each POST and answers as told.

const TOKEN = 'ab'.repeat(32);
const NONE: Omit<RunOptions, 'task'> = { scope: { kind: 'all' }, engine: 'none', yes: false, budget: 0, progress: () => {} };

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

let dir: string;
let home: string;
let store: Store;
let app: Server;
let port: number;
let seen: Seen[];
let answer: { status: number; body: string };
let agentToken: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-window-'));
  home = join(dir, 'home');
  store = demoRecord(dir, home);
  writeFileSync(join(home, 'token'), `${TOKEN}\n`);
  agentToken = allowAgent(home, 'claude-code', '2026-11-21T09:00:00.000Z').token;
  seen = [];
  answer = { status: 200, body: '{"ok":true}' };
  app = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  port = (app.address() as AddressInfo).port;
});
afterEach(async () => {
  await new Promise((resolve) => app.close(resolve));
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function open(p: number = port): Promise<McpServer<WindowCtx>> {
  const s = windowServer(context(home, store, { values: { window: true, port: String(p) }, token: agentToken }).ctx);
  await initialize(s);
  return s;
}

const entryIds = () => store.allEntries().slice(0, 2).map((e) => e.id);

describe('the window tools', () => {
  it('lists only the five window tools', async () => {
    const reply = await rpc(await open(), 'tools/list');
    expect((reply.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['show_in_brain', 'open_entry', 'open_hub', 'set_layout', 'highlight']);
  });

  it('posts each message to /api/window with the install token and the agent', async () => {
    await runSteps(store, new RecordView(store), steps(store, 'all'), NONE);
    const hub = liveHubs(store.db)[0]!.id;
    const [a, b] = entryIds();
    const s = await open();
    expect((await call(s, 'show_in_brain', { entry_ids: [a, b, a], hub_ids: [hub] })).text).toBe('Done.');
    expect((await call(s, 'open_entry', { entry_id: a })).isError).toBe(false);
    expect((await call(s, 'open_hub', { hub_id: hub })).isError).toBe(false);
    expect((await call(s, 'set_layout', { layout: 'rings', grouping: 'speaker' })).isError).toBe(false);
    expect((await call(s, 'set_layout', { layout: 'clusters' })).isError).toBe(false);
    expect((await call(s, 'highlight', { query: ' starter ' })).isError).toBe(false);
    expect((await call(s, 'highlight', {})).isError).toBe(false);
    expect(seen.map((r) => [r.method, r.url, r.headers['x-skeinwise-token'], r.headers['content-type']])).toEqual(
      Array(7).fill(['POST', '/api/window', TOKEN, 'application/json']),
    );
    expect(seen.map((r) => r.body)).toEqual([
      { type: 'show_in_brain', entryIds: [a, b], hubIds: [hub], agent: 'claude-code' },
      { type: 'open_entry', entryId: a, agent: 'claude-code' },
      { type: 'open_hub', hubId: hub, agent: 'claude-code' },
      { type: 'set_layout', layout: 'rings', grouping: 'speaker', agent: 'claude-code' },
      { type: 'set_layout', layout: 'clusters', agent: 'claude-code' },
      { type: 'highlight', query: 'starter', agent: 'claude-code' },
      { type: 'highlight', agent: 'claude-code' },
    ]);
  });

  it("passes on the app's own message", async () => {
    answer = { status: 200, body: '{"message":"Showing 2 entries."}' };
    expect((await call(await open(), 'open_entry', { entry_id: entryIds()[0] })).text).toBe('Done. Showing 2 entries.');
  });

  it('checks ids and names before anything goes to the app', async () => {
    const s = await open();
    expect((await call(s, 'open_entry', { entry_id: 999_999 })).text).toBe('There is no entry 999999 in the record.');
    expect((await call(s, 'open_hub', { hub_id: 999_999 })).text).toBe('There is no hub 999999. list_hubs names them.');
    expect((await call(s, 'show_in_brain', {})).text).toBe('Give at least one entry or hub id to show.');
    expect((await call(s, 'show_in_brain', { entry_ids: [0] })).text).toBe('Entry ids must be a list of ids.');
    expect((await call(s, 'set_layout', { layout: 'spiral' })).text).toBe('layout must be one of: brain, rings, clusters.');
    expect((await call(s, 'set_layout', { layout: 'brain', grouping: 'mood' })).text).toBe('grouping must be one of: project, folder, source, speaker.');
    expect((await call(s, 'highlight', { query: 3 })).text).toBe('query must be text.');
    expect(seen).toEqual([]);
  });

  it("says plainly when the app is locked, refuses the token, can't move its view, or fails", async () => {
    const s = await open();
    const id = entryIds()[0];
    answer = { status: 423, body: '{"error":"Skeinwise is locked"}' };
    expect((await call(s, 'open_entry', { entry_id: id })).text).toBe('Skeinwise is locked, so its tools are stopped. Unlock it in the app.');
    answer = { status: 401, body: '{"error":"Missing or wrong token"}' };
    expect((await call(s, 'open_entry', { entry_id: id })).text).toBe(`The app on port ${port} refused the install token from ${home}: it serves another record folder.`);
    answer = { status: 404, body: '{"error":"No such API"}' };
    expect((await call(s, 'open_entry', { entry_id: id })).text).toBe(`The app on port ${port} can't move its view yet. Update Skeinwise.`);
    answer = { status: 500, body: '{"error":"The brain view is still loading"}' };
    expect((await call(s, 'open_entry', { entry_id: id })).text).toBe('The app answered 500: The brain view is still loading');
    answer = { status: 502, body: 'Bad gateway' };
    expect((await call(s, 'open_entry', { entry_id: id })).text).toBe('The app answered 502: Bad gateway');
  });

  it('says when no app is listening, or there is no token yet', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const free = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const res = await call(await open(free), 'open_entry', { entry_id: entryIds()[0] });
    expect(res.text).toBe(`The Skeinwise app isn't answering on port ${free}. Start it with "skeinwise serve", or give its port with --port.`);
    rmSync(join(home, 'token'));
    expect((await call(await open(), 'open_entry', { entry_id: entryIds()[0] })).text).toBe(
      `There is no install token in ${join(home, 'token')} yet. Start the app once with "skeinwise serve", then try again.`,
    );
    expect(seen).toEqual([]);
  });

  it('keeps an agent without a token away from the window too', async () => {
    const s = windowServer(context(home, store, { values: { window: true, port: String(port) } }).ctx);
    await initialize(s, 'claude-code');
    expect((await call(s, 'open_entry', { entry_id: entryIds()[0] })).text).toMatch(/has no Skeinwise token/);
    expect(seen).toEqual([]);
  });
});
