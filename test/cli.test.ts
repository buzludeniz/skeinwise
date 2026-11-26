import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { buildThreads, DEMO_NOW, writeDemo } from '../src/demo/demo.ts';

let dir: string;

interface Call {
  home?: string;
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string>;
}

async function call(opts: Call, ...argv: string[]) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    out: (t) => (out += t),
    err: (t) => (err += t),
    env: { SKEINWISE_HOME: opts.home ?? join(dir, 'home'), ...opts.env },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return { code, out, err };
}

function cli(...argv: string[]) {
  return call({}, ...argv);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the skeinwise command', () => {
  it('prints help and version', async () => {
    expect((await cli('help')).out).toContain('Usage: skeinwise');
    expect((await cli('version')).out).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(JSON.parse((await cli('version', '--json')).out)).toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
  });

  it('keeps sync hidden in v1.0: no command, no flags, no help; export stays', async () => {
    const help = (await cli('help')).out;
    expect(help).toContain('export [<file>]');
    expect(help).not.toMatch(/sync (init|push|join|restore|status)|passphrase-file|phrase-file/);
    for (const argv of [['sync', 'status'], ['sync', 'init', join(dir, 'folder')]]) {
      const r = await cli(...argv);
      expect(r.code, argv.join(' ')).not.toBe(0);
      expect(r.err).toContain('Unknown command: sync');
    }
    const flag = await cli('export', join(dir, 'x.zip'), '--passphrase-file', join(dir, 'p'));
    expect(flag.code).not.toBe(0);
    expect(flag.err).toMatch(/passphrase-file/);
  });

  it('creates an owner-only record folder', async () => {
    expect(JSON.parse((await cli('init', '--json')).out)).toEqual({ home: join(dir, 'home') });
    expect(statSync(join(dir, 'home')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'home', 'record.db')).isFile()).toBe(true);
  });

  it('imports, searches, shows and re-imports without duplicates', async () => {
    const notes = join(dir, 'vault');
    mkdirSync(notes);
    writeFileSync(join(notes, 'bread.md'), '---\ntitle: Bread\ncreated: 2025-01-02\n---\nThe rye loaf needs a long proof. #baking');
    writeFileSync(join(notes, '2025-01-03.md'), 'Baked the rye loaf for the market.');

    const first = await cli('import', notes, '--json');
    expect(first.code).toBe(0);
    expect(JSON.parse(first.out)).toEqual([expect.objectContaining({ kind: 'notes', added: 2 })]);
    expect((await cli('import', notes)).out).toContain('0 new, 0 changed, 2 already in');

    const search = await cli('search', 'rye', 'loaf');
    expect(search.out).toMatch(/#\d+ {2}2025-01-0\d {2}you · vault/);
    expect(search.out).toContain('[rye] [loaf]');

    const hits = JSON.parse((await cli('search', 'rye', '--json', '--limit', '1')).out) as { id: number }[];
    expect(hits).toHaveLength(1);
    const show = await cli('show', String(hits[0]!.id));
    expect(show.out).toMatch(/rye loaf/);
    expect((await cli('history', String(hits[0]!.id))).out).toMatch(/^v1 .* by import/);

    const stats = (await cli('stats')).out;
    expect(stats).toContain('Woven from 2 entries');
    // Plan 7.3: the busiest months are plain text, with no bar glyphs.
    expect(stats).toMatch(/Busiest months:\n {2}\d{4}-\d{2} {2}2 entries\n/);
    expect(stats).not.toMatch(/[\u2580-\u259F\u2500-\u257F]/);
    expect((await cli('sources')).out).toMatch(/1 {2}in {4}vault \(notes\): 2 entries/);
    expect(JSON.parse((await cli('exclude', '1', '--json')).out)).toEqual({ source: 1, status: 'out' });
    expect((await cli('search', 'rye')).out).toContain('Nothing found');
    expect((await cli('include', '1')).code).toBe(0);
    expect((await cli('search', 'rye')).out).toContain('[rye]');
  });

  it('keeps someone else’s notes under their name', async () => {
    const notes = join(dir, 'mara');
    mkdirSync(notes);
    writeFileSync(join(notes, 'route.md'), 'Split the ride at the reservoir.');
    await cli('import', notes, '--owner', 'Mara');
    expect((await cli('search', 'reservoir', '--speaker', 'Mara')).out).toContain('Mara · mara');
    expect((await cli('search', 'reservoir', '--speaker', 'you')).out).toContain('Nothing found');
  });

  it('filters search by the folder a coding session ran in, with --project', async () => {
    const projects = join(dir, 'claude-code', 'projects');
    const sessions: [string, string, string][] = [
      ['s-plot', '/home/mara/code/plotline', 'Reminders go out twice in plotline'],
      ['s-ledger', '/home/mara/code/ledger', 'Reminders for invoices go out twice'],
    ];
    for (const [id, cwd, prompt] of sessions) {
      const folder = join(projects, cwd.replaceAll('/', '-'));
      mkdirSync(folder, { recursive: true });
      const line = { type: 'user', uuid: `${id}-u1`, sessionId: id, cwd, gitBranch: 'main', timestamp: '2026-04-01T09:00:00.000Z' };
      writeFileSync(join(folder, `${id}.jsonl`), `${JSON.stringify({ ...line, message: { role: 'user', content: prompt } })}\n`);
    }
    expect((await cli('import', join(dir, 'claude-code'))).code).toBe(0);
    expect((await cli('help')).out).toMatch(/--to <date> .*\n {6}--project <name> +Only coding sessions/);

    const all = JSON.parse((await cli('search', 'reminders', '--json')).out) as { id: number }[];
    expect(all).toHaveLength(2);
    const plot = await cli('search', 'reminders', '--project', 'plotline', '--json');
    expect(plot.code).toBe(0);
    const hits = JSON.parse(plot.out) as { id: number }[];
    expect(hits).toHaveLength(1);
    expect(JSON.parse((await cli('show', String(hits[0]!.id), '--json')).out)).toMatchObject({ project: '/home/mara/code/plotline', gitBranch: 'main' });
    expect((await cli('search', 'reminders', '--project', 'plot')).out).toContain('Nothing found');
  });

  it('restores an old version of an entry as a new one', async () => {
    const notes = join(dir, 'vault');
    mkdirSync(notes);
    writeFileSync(join(notes, 'plan.md'), 'Paint the shed green.');
    await cli('import', notes);
    writeFileSync(join(notes, 'plan.md'), 'Paint the shed blue.');
    expect((await cli('import', notes)).out).toContain('0 new, 1 changed');
    expect((await cli('help')).out).toMatch(/history <entry> .*\n {2}restore <entry> <version> /);

    const restored = await cli('restore', '1', '1');
    expect(restored).toMatchObject({ code: 0, out: 'Entry 1 reads as version 1 again, saved as version 3. Every version is kept.\n' });
    expect((await cli('show', '1')).out).toContain('Paint the shed green.');
    expect((await cli('history', '1')).out.trim().split('\n')).toHaveLength(3);
    expect(JSON.parse((await cli('restore', '1', '1', '--json')).out)).toEqual({ entry: 1, restored: 1, version: 3, changed: false });
    expect(await cli('restore', '1', '9')).toMatchObject({ code: 2, err: expect.stringContaining('has no version 9') });
    expect(await cli('restore', '1')).toMatchObject({ code: 2, err: expect.stringContaining('Give an entry and a version') });
  });

  it('says when an export from another account waits in pending instead of "0 new"', async () => {
    const claude = (account: string, text: string) =>
      JSON.stringify([
        {
          uuid: 'conv-1',
          name: 'Choosing a database',
          created_at: '2026-03-01T10:00:00Z',
          account: { uuid: account },
          chat_messages: [{ uuid: 'msg-1', sender: 'human', text, created_at: '2026-03-01T10:00:00Z' }],
        },
      ]);
    const mine = join(dir, 'mine.json');
    const theirs = join(dir, 'theirs.json');
    writeFileSync(mine, claude('acct-invented-a', 'We decided on Postgres.'));
    writeFileSync(theirs, claude('acct-invented-b', 'We decided on MongoDB.'));
    expect((await cli('import', mine)).out).toContain('1 new');

    const held = await cli('import', theirs);
    expect(held.code).toBe(0);
    expect(held.out).toBe("Claude: 1 change from another account than this source's wait for your yes as #1; nothing was imported: skeinwise live pending\n");
    expect(JSON.parse((await cli('import', theirs, '--json')).out)).toEqual([
      expect.objectContaining({ kind: 'claude', added: 0, versioned: 0, proposed: 1, pendingId: null }),
    ]);
    expect((await cli('import', theirs)).out).toBe('Claude: nothing imported; this export from another account was proposed before as #1 (pending)\n');
    expect((await cli('show', '1')).out).toContain('We decided on Postgres.');

    // live pending, accept and reject are routed to the pending commands, with --all.
    expect((await cli('help')).out).toMatch(/--once .*\n {2}live pending .*\n.*\n {2}live accept <n> .*\n {2}live reject <n> /);
    const waiting = await cli('live', 'pending');
    expect(waiting.code).toBe(0);
    expect(waiting.out).toContain('1 import waits for your yes:');
    expect(waiting.out).toContain("#1  Claude · 1 chat, 1 entry to add or change");
    expect(waiting.out).toContain(`from ${theirs}, `);
    expect(await cli('live', 'reject', '1')).toMatchObject({ code: 0, out: expect.stringContaining('Left #1 out for good.') });
    expect((await cli('live', 'pending')).out).toBe('Nothing waits for your yes.\n');
    expect((await cli('live', 'pending', '--all')).out).toContain('1 import proposed, 0 waiting:');
    expect(await cli('live', 'accept', '1')).toMatchObject({ code: 2, err: expect.stringContaining('#1 was already rejected') });
    expect((await cli('show', '1')).out).toContain('We decided on Postgres.');
    expect((await cli('import', theirs)).out).toBe('Claude: nothing imported; this export from another account was proposed before as #1 (rejected)\n');
  });

  it('takes a waiting import into the record with live accept', async () => {
    const claude = (account: string, text: string) =>
      JSON.stringify([
        {
          uuid: 'conv-1',
          name: 'Choosing a database',
          created_at: '2026-03-01T10:00:00Z',
          account: { uuid: account },
          chat_messages: [{ uuid: 'msg-1', sender: 'human', text, created_at: '2026-03-01T10:00:00Z' }],
        },
      ]);
    const mine = join(dir, 'mine.json');
    const theirs = join(dir, 'theirs.json');
    writeFileSync(mine, claude('acct-invented-a', 'We decided on Postgres.'));
    writeFileSync(theirs, claude('acct-invented-b', 'We decided on MongoDB.'));
    await cli('import', mine);
    await cli('import', theirs);
    const accepted = await cli('live', 'accept', '1', '--json');
    expect(accepted.code).toBe(0);
    expect(JSON.parse(accepted.out)).toMatchObject({ id: 1, added: 0, versioned: 1 });
    expect((await cli('show', '1')).out).toContain('We decided on MongoDB.');
    expect((await cli('history', '1')).out.trim().split('\n')).toHaveLength(2);
  });

  it('fails loudly with usage errors', async () => {
    expect(await cli('nope')).toMatchObject({ code: 2, err: expect.stringContaining('Unknown command: nope') });
    expect(await cli('show')).toMatchObject({ code: 2, err: expect.stringContaining('entry number') });
    expect(await cli('show', '99')).toMatchObject({ code: 2, err: expect.stringContaining('No entry 99') });
    expect(await cli('import')).toMatchObject({ code: 2 });
    expect(await cli('search')).toMatchObject({ code: 2 });
    expect(await cli('import', join(dir, 'missing'))).toMatchObject({ code: 1, err: expect.stringContaining('ENOENT') });
    expect((await cli('search', 'x', '--bogus')).code).toBe(1);
    // A word live doesn't know is a mistake, not a reason to start recording.
    expect(await cli('live', 'pendng')).toMatchObject({ code: 2, err: expect.stringContaining('Unknown live command: pendng') });
    expect(await cli('live', 'toString')).toMatchObject({ code: 2, err: expect.stringContaining('Unknown live command') });
    expect(await cli('live', 'accept')).toMatchObject({ code: 2, err: expect.stringContaining('Give one number') });
  });
});

describe('the demo record', () => {
  it('is the same for the same seed and never dated after the demo’s today', () => {
    const a = buildThreads(7);
    expect(buildThreads(7)).toEqual(a);
    expect(buildThreads(8)).not.toEqual(a);
    for (const t of a) for (const m of t.messages) expect(m.at.getTime()).toBeLessThanOrEqual(Date.parse(DEMO_NOW) + 3600_000);
  });

  it('writes files the importers read', () => {
    const summary = writeDemo(join(dir, 'exports'));
    expect(summary.files).toEqual(expect.arrayContaining(['chatgpt/conversations.json', 'claude/conversations.json']));
    const claude = JSON.parse(readFileSync(join(dir, 'exports', 'claude', 'conversations.json'), 'utf8')) as unknown[];
    expect(claude.length).toBeGreaterThan(10);
  });

  it('builds a searchable record and refuses to mix with a real one', async () => {
    const run = await cli('demo', '--json');
    expect(run.code).toBe(0);
    const result = JSON.parse(run.out) as { threads: number; results: { source: string; added: number }[] };
    expect(result.results.map((r) => r.source)).toEqual(['ChatGPT', 'Claude', 'Claude Code', 'notes']);
    expect(result.results.every((r) => r.added > 0)).toBe(true);

    const decisions = (await cli('search', 'what did I decide about sqlite', '--limit', '3')).out;
    expect(decisions).toContain('Plotline runs on [SQLite]');
    expect(decisions).toContain('Changing my mind on [SQLite]');

    expect(await cli('demo')).toMatchObject({ code: 2, err: expect.stringContaining('is not empty') });
    expect((await cli('demo', '--force')).code).toBe(0);
  });
});

describe('export from the command line (sync is hidden in v1.0; test/sync covers its module)', () => {
  it('lists export in help and exports a zip', async () => {
    expect((await cli('help')).out).toContain('export [<file>]');
    expect((await cli('demo', '--out', join(dir, 'demo'))).code).toBe(0);

    const zip = join(dir, 'record.zip');
    const exported = await cli('export', zip);
    expect(exported.code).toBe(0);
    expect(readFileSync(zip).subarray(0, 2).toString()).toBe('PK');
  });
});

describe('connectors, which are off in v1.0', () => {
  it('leaves them out of help and refuses their commands', async () => {
    const help = (await cli('help')).out;
    expect(help).not.toMatch(/connect <service>|disconnect <service>|Connectors/);
    for (const command of ['connections', 'disconnect']) {
      const run = await cli(command, 'gmail');
      expect(run.code).toBe(2);
      expect(run.err).toMatch(new RegExp(`Unknown command: ${command}\\.`));
    }
    // `connect` is the agents' command in v1.0 (setup.ts): a service name gets the list of agents, not a connector.
    const gmail = await cli('connect', 'gmail');
    expect(gmail.code).toBe(2);
    expect(gmail.err).toContain('Name the agent to connect: skeinwise connect claude-code');
    expect((await cli('connect', '--client-id', 'x')).err).toMatch(/Unknown option '--client-id'/);
  });
});

describe('agent access from the command line', () => {
  it('lists the mcp commands in help, and allows, lists and locks agents', async () => {
    expect((await cli('help')).out).toContain('mcp allow <agent>');
    expect((await cli('demo', '--out', join(dir, 'demo'))).code).toBe(0);
    expect((await cli('mcp', 'allow', 'claude-code')).code).toBe(0);
    expect((await cli('mcp', 'lock')).code).toBe(0);
    const agents = JSON.parse((await cli('mcp', 'agents', '--json')).out) as { locked: boolean; allowed: Record<string, string> };
    expect(agents.locked).toBe(true);
    expect(Object.keys(agents.allowed)).toEqual(['claude-code']);
    expect((await cli('mcp', 'allow', 'you')).code).toBe(2);
  });
});

describe('skeinwise serve', () => {
  /** Starts `skeinwise serve` on a free port, in a pretend home folder, and returns the token its address carries. */
  async function serve(...flags: string[]): Promise<{ base: string; token: string }> {
    let out = '';
    let err = '';
    const scan = join(dir, 'scan');
    mkdirSync(scan, { recursive: true });
    const code = await main(['serve', '--port', '0', ...flags], {
      out: (t) => (out += t),
      err: (t) => (err += t),
      env: { SKEINWISE_HOME: join(dir, 'home'), SKEINWISE_SCAN_ROOT: scan },
    });
    expect(code).toBe(0);
    const deadline = Date.now() + 10_000;
    while (!/^Open: /m.test(out)) {
      if (err || Date.now() > deadline) throw new Error(`serve never printed its address: ${err}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    const url = new URL(/^Open: (\S+)$/m.exec(out)![1]!);
    return { base: url.origin, token: /^#token=([0-9a-f]{64})$/.exec(url.hash)![1]! };
  }

  /** Stops it through the app's own Quit, and waits until the port is closed. */
  async function quit({ base, token }: { base: string; token: string }): Promise<void> {
    const res = await fetch(`${base}/api/quit`, { method: 'POST', headers: { 'X-Skeinwise-Token': token } });
    expect(res.status).toBe(200);
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await fetch(`${base}/api/status`, { headers: { 'X-Skeinwise-Token': token } });
      } catch {
        return;
      }
      if (Date.now() > deadline) throw new Error('serve never stopped');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('names --keep-token in help', async () => {
    const help = (await cli('help')).out;
    const serveHelp = help.slice(help.indexOf('\n  serve '), help.indexOf('\nOrganising'));
    expect(serveHelp).toMatch(/^ {6}--keep-token +\S/m);
  });

  it('makes a new token at every start, and keeps the last one with --keep-token', async () => {
    const first = await serve();
    await quit(first);
    const kept = await serve('--keep-token');
    expect(kept.token).toBe(first.token);
    await quit(kept);
    const next = await serve();
    expect(next.token).not.toBe(first.token);
    // The address from before the new start no longer opens anything.
    const old = await fetch(`${next.base}/api/status`, { headers: { 'X-Skeinwise-Token': first.token } });
    expect(old.status).toBe(401);
    await quit(next);
  });
});
