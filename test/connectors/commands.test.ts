// connect, connections and disconnect, run with a Ctx built here, the way the CLI will call them. The network, the
// Keychain, the prompts and the browser are fakes; the only real request is the fake browser's, to 127.0.0.1.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx, Values } from '../../src/cli-organiser.ts';
import { CONNECTOR_COMMANDS, CONNECTOR_FLAGS, CONNECTOR_HELP, type ConnectorIo } from '../../src/connectors/commands.ts';
import { keychainItems } from '../../src/connectors/keychain.ts';
import { GOOGLE, GOOGLE_REVOKE_URL } from '../../src/connectors/oauth.ts';
import { pollConnectors } from '../../src/connectors/poll.ts';
import { findConnection, loadConnections } from '../../src/connectors/state.ts';
import { UsageError } from '../../src/errors.ts';
import type { Store } from '../../src/store/store.ts';
import {
  allFilesText,
  approvingBrowser,
  type Clock,
  clock,
  FakeKeychain,
  fakeFetch,
  fixture,
  json,
  on,
  seedConnection,
  tempHome,
} from './helpers.ts';
import { keyShaped } from '../samples.ts';

// Slack-shaped tokens are joined at run time, so the source holds no literal in Slack's key format.
const USER_TOKEN = keyShaped('xo', 'xp-test-not-a-real-token');
const SHORT_USER_TOKEN = keyShaped('xo', 'xp-test-token');
const BOT_TOKEN = keyShaped('xo', 'xb-test-token');

vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('No processes in this test');
  },
}));

let home: string;
let store: Store;
let keychain: FakeKeychain;
let time: Clock;

beforeEach(() => {
  time = clock();
  ({ home, store } = tempHome(time.now));
  keychain = new FakeKeychain();
});

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Runs one connector command as the CLI would: a UsageError exits 2 with its message, any other error exits 1. */
async function run(name: string, args: string[], values: Record<string, unknown>, io: Partial<ConnectorIo> = {}): Promise<Run> {
  let out = '';
  let err = '';
  const ctx: Ctx = {
    io: {
      out: (t) => void (out += t),
      err: (t) => void (err += t),
      env: {},
      ask: async () => null,
      fetch: fakeFetch([]),
      ...io,
      askSecret: io.askSecret ?? (async () => null),
      openUrl:
        io.openUrl ??
        (async () => {
          throw new Error('No browser in this test');
        }),
      keychain,
      platform: io.platform ?? 'darwin',
    } as ConnectorIo,
    home,
    store,
    values: values as Values,
    args,
    json: (v) => void (out += `${JSON.stringify(v, null, 2)}\n`),
  };
  try {
    const code = await CONNECTOR_COMMANDS[name]!(ctx);
    return { code, out, err };
  } catch (error) {
    err += `skeinwise: ${(error as Error).message}\n`;
    return { code: error instanceof UsageError ? 2 : 1, out, err };
  }
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MESSAGES = fixture<Record<string, unknown>>('gmail-messages.json');
const SLACK = fixture<{ authTest: unknown; channels: unknown; users: Record<string, unknown>; plantsPage1: unknown; plantsPage2: unknown }>('slack.json');
const READ_SCOPES = 'channels:history,channels:read,groups:history,groups:read,users:read';

function gmailNetwork(scope = 'https://www.googleapis.com/auth/gmail.readonly') {
  return fakeFetch([
    on('POST', GOOGLE.tokenUrl, () => json({ access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: 3600, scope })),
    on('GET', `${GMAIL}/profile`, () => json({ emailAddress: 'sam@example.com', historyId: '1000' })),
    on('GET', `${GMAIL}/messages`, () => json({ messages: [{ id: 'msg-a1', threadId: 'thr-picnic' }] })),
    on('GET', `${GMAIL}/messages/msg-a1`, () => json(MESSAGES['msg-a1'])),
    on('POST', GOOGLE_REVOKE_URL, () => json({})),
  ]);
}

function slackNetwork(scopes = READ_SCOPES) {
  return fakeFetch([
    on('GET', 'https://slack.com/api/auth.test', () => json(SLACK.authTest, 200, { 'x-oauth-scopes': scopes })),
    on('GET', 'https://slack.com/api/conversations.list', () => json(SLACK.channels)),
    on('GET', 'https://slack.com/api/users.info', (call) => json(SLACK.users[call.url.searchParams.get('user')!])),
    on('GET', 'https://slack.com/api/conversations.history', (call) => json(call.url.searchParams.get('cursor') === 'plants-2' ? SLACK.plantsPage2 : SLACK.plantsPage1)),
    on('GET', 'https://slack.com/api/auth.revoke', () => json({ ok: true, revoked: true })),
  ]);
}

function secretFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'skeinwise-secret-')), 'secret.txt');
  writeFileSync(path, `${text}\n`);
  return path;
}

describe('what the CLI wires in', () => {
  it('every flag parses alongside the CLI’s own, and the help names each one', () => {
    const { values } = parseArgs({
      args: ['connect', 'slack', '--channels', 'general,plants', '--token-file', 't.txt', '--from', '2026-09-01', '--yes', '--drop', '--port', '9000'],
      allowPositionals: true,
      options: { ...CONNECTOR_FLAGS, from: { type: 'string' }, yes: { type: 'boolean' }, json: { type: 'boolean' } },
    });
    expect(values).toMatchObject({ channels: 'general,plants', 'token-file': 't.txt', yes: true, drop: true, port: '9000' });
    for (const flag of Object.keys(CONNECTOR_FLAGS)) expect(CONNECTOR_HELP).toContain(`--${flag}`);
    for (const command of Object.keys(CONNECTOR_COMMANDS)) expect(CONNECTOR_HELP).toContain(`  ${command}`);
  });
});

describe('skeinwise connect', () => {
  it('shows what it reads and the permission it asks for before any sign-in, then signs in and pulls', async () => {
    const order: string[] = [];
    let outAtAsk = '';
    const seen: string[] = [];
    const browser = approvingBrowser('test-auth-code', seen);
    const fetch = gmailNetwork();
    const r = await run('connect', ['gmail'], { 'client-id': 'test-client.apps.example' }, {
      fetch,
      ask: async () => {
        order.push('asked');
        return 'y';
      },
      askSecret: async (prompt) => {
        order.push(`secret: ${prompt}`);
        return '';
      },
      openUrl: async (url) => {
        order.push('browser');
        await browser(url);
      },
    }).then((x) => {
      outAtAsk = x.out.slice(0, x.out.indexOf('Opening'));
      return x;
    });
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(order).toEqual(['asked', 'secret: Gmail client secret (press Enter if your client has none): ', 'browser']);
    expect(outAtAsk).toContain('Connect Gmail (read-only)');
    expect(outAtAsk).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(outAtAsk).toContain('It never sends, posts, deletes or changes anything in Gmail');
    expect(outAtAsk).toContain(`account "${keychainItems(home, 'gmail').token}"`);
    expect(new URL(seen[0]!).searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(r.out).toContain('Connected Gmail as sam@example.com. Reading it now...');
    expect(r.out).toContain('Gmail (sam@example.com): 1 new');
    expect(store.allEntries()).toHaveLength(1);

    // The token is in the Keychain and nowhere else: not in the record folder, not in what was printed.
    expect(JSON.parse(keychain.items.get(keychainItems(home, 'gmail').token)!)).toMatchObject({ access: 'test-access-token', refresh: 'test-refresh-token' });
    for (const secret of ['test-access-token', 'test-refresh-token', 'test-auth-code']) {
      expect(allFilesText(home)).not.toContain(secret);
      expect(r.out + r.err).not.toContain(secret);
    }
    expect(findConnection(home, 'gmail')).toMatchObject({ account: 'sam@example.com', clientId: 'test-client.apps.example', since: '2026-08-27T12:00:00.000Z' });
    // Nothing that writes: the only calls are the token exchange and reads.
    for (const c of fetch.calls) expect(c.method === 'GET' || c.url.toString() === GOOGLE.tokenUrl).toBe(true);
  });

  it('says it isn’t supported yet anywhere but macOS, before asking or reaching anything', async () => {
    const fetch = fakeFetch([]);
    const r = await run('connect', ['gmail'], { 'client-id': 'c', yes: true }, { fetch, platform: 'linux' });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Connecting isn't supported on Linux yet");
    expect(r.out).toBe('');
    expect(fetch.calls).toHaveLength(0);
    expect(keychain.items.size).toBe(0);
  });

  it('asks for the person’s own OAuth client and points to the docs, before the consent', async () => {
    const r = await run('connect', ['calendar'], { yes: true });
    expect(r.code).toBe(2);
    expect(r.err).toContain('needs your own OAuth client: Skeinwise ships none. docs/connectors.md');
    expect(r.out).toBe('');
  });

  it('with no terminal to ask on, stops after the consent and says to use --yes', async () => {
    const openUrl = vi.fn(async () => {});
    const r = await run('connect', ['gmail'], { 'client-id': 'c' }, { openUrl });
    expect(r.code).toBe(2);
    expect(r.out).toContain('Connect Gmail (read-only)');
    expect(r.err).toContain('run the same command with --yes');
    expect(openUrl).not.toHaveBeenCalled();
    expect(loadConnections(home)).toEqual([]);
  });

  it('saying no connects nothing', async () => {
    const r = await run('connect', ['gmail'], { 'client-id': 'c' }, { ask: async () => 'n' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('Not connected. Nothing was saved.');
    expect(keychain.items.size).toBe(0);
  });

  it('refuses when Google didn’t grant the read permission (the box left unticked)', async () => {
    const r = await run('connect', ['gmail'], { 'client-id': 'c', yes: true }, { fetch: gmailNetwork('openid'), openUrl: approvingBrowser() });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Gmail didn't grant https://www.googleapis.com/auth/gmail.readonly");
    expect(keychain.items.size).toBe(0);
    expect(loadConnections(home)).toEqual([]);
  });

  it('Todoist needs a client secret, from a file when there is no terminal', async () => {
    const r = await run('connect', ['todoist'], { 'client-id': 'test-todoist-client', yes: true });
    expect(r.code).toBe(2);
    expect(r.err).toContain('--client-secret-file <file>');
  });

  it('Slack: takes a pasted user token with read scopes only, and the picked channels', async () => {
    const tokenFile = secretFile(USER_TOKEN);
    const fetch = slackNetwork();
    const r = await run('connect', ['slack'], { 'token-file': tokenFile, channels: '#plants', yes: true }, { fetch });
    expect(r.err).toBe('');
    expect(r.out).toContain('channels:history\n      read messages in the public channels you pick');
    expect(r.out).toContain('Connected Slack as Garden Club.');
    expect(r.out).toContain('Slack (Garden Club): 2 new');
    expect(findConnection(home, 'slack')).toMatchObject({ account: 'Garden Club', picks: ['C0PLANTS'] });
    expect(keychain.items.get(keychainItems(home, 'slack').token)).toBe(JSON.stringify({ access: USER_TOKEN }));
    expect(allFilesText(home)).not.toContain(USER_TOKEN);
    expect(fetch.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('Slack: refuses a token that can do more than read, and a bot token', async () => {
    const more = await run('connect', ['slack'], { 'token-file': secretFile(SHORT_USER_TOKEN), channels: 'plants', yes: true }, { fetch: slackNetwork(`${READ_SCOPES},chat:write`) });
    expect(more.code).toBe(2);
    expect(more.err).toContain('This token can do more than read (chat:write)');
    const bot = await run('connect', ['slack'], { 'token-file': secretFile(BOT_TOKEN), channels: 'plants', yes: true }, { fetch: slackNetwork() });
    expect(bot.code).toBe(2);
    expect(bot.err).toContain("That isn't a User OAuth Token");
    expect(keychain.items.size).toBe(0);
    expect(loadConnections(home)).toEqual([]);
  });

  it('Slack: an unknown channel stops the connect with nothing saved', async () => {
    const r = await run('connect', ['slack'], { 'token-file': secretFile(SHORT_USER_TOKEN), channels: 'plants,recipes', yes: true }, { fetch: slackNetwork() });
    expect(r.code).toBe(2);
    expect(r.err).toContain('Slack has no channel you can read called #recipes');
    expect(keychain.items.size).toBe(0);
  });

  it('checks --from and --port before anything else', async () => {
    expect((await run('connect', ['gmail'], { 'client-id': 'c', from: '2027-01-01' })).err).toContain('--from 2027-01-01 is in the future.');
    expect((await run('connect', ['gmail'], { 'client-id': 'c', from: 'last week' })).err).toContain('--from takes a date like 2026-09-01');
    expect((await run('connect', ['todoist'], { 'client-id': 'c', port: '80' })).err).toContain('--port takes a port from 1024 to 65535');
    expect((await run('connect', ['dropbox'], {})).err).toContain('Connect which service? One of: gmail, calendar, todoist, slack.');
  });
});

describe('skeinwise connections', () => {
  it('says nothing is connected, and how to start', async () => {
    const r = await run('connections', [], {});
    expect(r.out).toBe('Nothing is connected. Try: skeinwise connect gmail (or calendar, todoist, slack)\n');
  });

  it('lists each connection with how its last pull went and when the next one is', async () => {
    await seedConnection(home, keychain, { service: 'slack', account: 'Garden Club', picks: ['C0PLANTS'], cursor: { channels: { C0PLANTS: { name: 'plants' } }, users: {} } }, { access: keyShaped('xo', 'xp-test') });
    await seedConnection(home, keychain, { service: 'gmail', account: 'sam@example.com', clientId: 'c' }, { access: 'test-access-token' });
    const fetch = slackNetwork();
    fetch.routes.push(on('GET', `${GMAIL}/profile`, () => json({ error: { code: 401 } }, 401)));
    await pollConnectors(store, home, { fetch, keychain, now: time.now, platform: 'darwin' });
    time.add(2);
    const r = await run('connections', [], {});
    expect(r.out).toBe(
      [
        'Slack            Garden Club · #plants · connected 2026-11-25',
        '  Slack (Garden Club): 2 new',
        '  Next pull in 3 minutes (while skeinwise live runs)',
        'Gmail            sam@example.com · connected 2026-11-25',
        '  Gmail (sam@example.com): Gmail signed Skeinwise out (the access was revoked or ran out); connect again. Run: skeinwise connect gmail',
        '  Pulls are stopped until you connect again.',
        'Not connected: calendar, todoist',
        '',
      ].join('\n'),
    );
    const listed = JSON.parse((await run('connections', [], { json: true })).out) as Record<string, unknown>[];
    expect(listed.map((c) => [c.source, c.failure])).toEqual([
      ['slack:Garden Club', null],
      ['gmail:sam@example.com', 'signed-out'],
    ]);
    expect(JSON.stringify(listed)).not.toContain('cursor');
  });
});

describe('skeinwise disconnect', () => {
  async function connectedGmail() {
    await seedConnection(
      home,
      keychain,
      { service: 'gmail', account: 'sam@example.com', clientId: 'c' },
      { access: 'test-access-token', refresh: 'test-refresh-token', expiresAt: '2026-11-25T13:00:00.000Z' },
      'test-client-secret',
    );
    await pollConnectors(store, home, { fetch: gmailNetwork(), keychain, now: time.now, platform: 'darwin' });
    expect(store.allEntries()).toHaveLength(1);
  }

  it('--keep: revokes the access at Google, deletes the token, keeps what was read', async () => {
    await connectedGmail();
    const fetch = gmailNetwork();
    const r = await run('disconnect', ['gmail'], { keep: true }, { fetch });
    expect(r.code).toBe(0);
    const revoke = fetch.calls.find((c) => c.url.toString() === GOOGLE_REVOKE_URL)!;
    expect(new URLSearchParams(revoke.body).get('token')).toBe('test-refresh-token');
    expect(keychain.items.size).toBe(0);
    expect(loadConnections(home)).toEqual([]);
    expect(r.out).toBe(
      [
        "Revoked Skeinwise's access at Gmail and deleted the token from the Keychain.",
        'Kept the 1 item from gmail:sam@example.com (source 1).',
        'Gmail is disconnected.',
        '',
      ].join('\n'),
    );
    expect(store.allEntries()).toHaveLength(1);
  });

  it('asks whether to keep the items, and "n" leaves them out of search', async () => {
    await connectedGmail();
    const questions: string[] = [];
    const r = await run('disconnect', ['gmail'], {}, {
      fetch: gmailNetwork(),
      ask: async (q) => {
        questions.push(q);
        return 'n';
      },
    });
    expect(questions).toEqual(['Keep the 1 item read from gmail:sam@example.com in search? [Y/n] ']);
    expect(r.out).toContain('Left the 1 item from gmail:sam@example.com out of search and the map (source 1; skeinwise include 1 brings them back)');
    expect(store.allEntries()).toHaveLength(0);
    expect(store.sources()[0]!.status).toBe('out');
  });

  it('with no terminal and no --keep or --drop, changes nothing', async () => {
    await connectedGmail();
    const fetch = gmailNetwork();
    const r = await run('disconnect', ['gmail'], {}, { fetch });
    expect(r.code).toBe(2);
    expect(r.err).toContain('--keep or --drop');
    expect(fetch.calls).toHaveLength(0);
    expect(keychain.items.size).toBe(2);
    expect(findConnection(home, 'gmail')).not.toBeNull();
  });

  it('when the service can’t be reached, still deletes the token and says how to revoke by hand', async () => {
    await connectedGmail();
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    const r = await run('disconnect', ['gmail'], { drop: true }, { fetch: down });
    expect(r.code).toBe(0);
    expect(r.err).toContain("Couldn't revoke the access at Gmail");
    expect(r.err).toContain('https://myaccount.google.com/permissions');
    expect(r.out).toContain('Deleted the token from the Keychain.');
    expect(keychain.items.size).toBe(0);
  });

  it('Todoist revokes with the person’s own client; Slack with auth.revoke', async () => {
    await seedConnection(home, keychain, { service: 'todoist', account: 'sam@example.com', clientId: 'test-todoist-client' }, { access: 'test-todoist-token' }, 'test-todoist-secret');
    const todoist = fakeFetch([on('POST', 'https://api.todoist.com/api/v1/revoke', () => new Response(null, { status: 204 }))]);
    expect((await run('disconnect', ['todoist'], {}, { fetch: todoist })).code).toBe(0);
    const call = todoist.calls[0]!;
    expect(call.headers.get('authorization')).toBe(`Basic ${Buffer.from('test-todoist-client:test-todoist-secret').toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({ token: 'test-todoist-token', token_type_hint: 'access_token' });

    await seedConnection(home, keychain, { service: 'slack', account: 'Garden Club', picks: [] }, { access: keyShaped('xo', 'xp-test') });
    const slack = slackNetwork();
    expect((await run('disconnect', ['slack'], {}, { fetch: slack })).code).toBe(0);
    expect(slack.calls.map((c) => c.url.pathname)).toEqual(['/api/auth.revoke']);
    expect(keychain.items.size).toBe(0);
  });

  it('connecting again after --drop brings the items back into search', async () => {
    await connectedGmail();
    await run('disconnect', ['gmail'], { drop: true }, { fetch: gmailNetwork() });
    expect(store.allEntries()).toHaveLength(0);
    const r = await run('connect', ['gmail'], { 'client-id': 'c', yes: true }, { fetch: gmailNetwork(), askSecret: async () => '', openUrl: approvingBrowser() });
    expect(r.err).toBe('');
    expect(r.out).toContain('Source 1 (gmail:sam@example.com) was left out; it is back in.');
    expect(store.allEntries()).toHaveLength(1);
  });

  it('warns that Calendar may lose its access too when it shares Gmail’s Google client', async () => {
    await connectedGmail();
    await seedConnection(home, keychain, { service: 'calendar', account: 'sam@example.com', clientId: 'c', picks: ['primary'] }, { access: 'test-calendar-token' });
    const r = await run('disconnect', ['gmail'], { keep: true }, { fetch: gmailNetwork() });
    expect(r.code).toBe(0);
    expect(r.err).toContain('Note: Google Calendar uses the same Google client, and Google may have ended its access too.');
    expect(findConnection(home, 'calendar')).not.toBeNull();
  });

  it('says so when the service isn’t connected', async () => {
    const r = await run('disconnect', ['calendar'], { keep: true });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Google Calendar isn't connected.");
  });
});
