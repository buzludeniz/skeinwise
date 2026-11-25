import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyText, dropQuoted, threadTitle } from '../../src/connectors/gmail.ts';
import { GOOGLE } from '../../src/connectors/oauth.ts';
import { pollConnectors } from '../../src/connectors/poll.ts';
import { findConnection } from '../../src/connectors/state.ts';
import type { Store } from '../../src/store/store.ts';
import { allFilesText, type Call, type Clock, clock, FakeKeychain, fakeFetch, fixture, json, on, seedConnection, tempHome } from './helpers.ts';

vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('No processes in this test');
  },
}));

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
type Message = { id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: unknown };
const MESSAGES = fixture<Record<string, Message>>('gmail-messages.json');

let home: string;
let store: Store;
let keychain: FakeKeychain;
let time: Clock;
let history: (call: Call) => Response;
let listed: string[];
let messages: Record<string, Message>;

function network() {
  return fakeFetch([
    on('GET', `${API}/profile`, () => json({ emailAddress: 'sam@example.com', historyId: '1000' })),
    on('GET', `${API}/messages`, () => json({ messages: listed.map((id) => ({ id, threadId: messages[id]?.threadId ?? 'x' })), resultSizeEstimate: listed.length })),
    (call) => {
      const m = /\/messages\/([^/]+)$/.exec(call.url.pathname);
      if (call.url.origin + call.url.pathname.replace(/\/messages\/[^/]+$/, '') !== API || !m) return undefined;
      const msg = messages[decodeURIComponent(m[1]!)];
      return msg ? json(msg) : json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404);
    },
    on('GET', `${API}/history`, (call) => history(call)),
  ]);
}

const poll = (fetch: typeof globalThis.fetch, force = false) =>
  pollConnectors(store, home, { fetch, keychain, now: time.now, platform: 'darwin', force });

beforeEach(async () => {
  time = clock();
  ({ home, store } = tempHome(time.now));
  keychain = new FakeKeychain();
  messages = { ...MESSAGES };
  // Gmail lists newest first, and lists spam only when asked; this listing has some anyway, to test the skip.
  listed = ['msg-spam', 'msg-b1', 'msg-a2', 'msg-a1'];
  history = () => json({ historyId: '1000' });
  await seedConnection(
    home,
    keychain,
    { service: 'gmail', account: 'sam@example.com', clientId: 'test-client.apps.example' },
    { access: 'test-access-token', refresh: 'test-refresh-token', expiresAt: '2026-11-25T13:00:00.000Z' },
  );
});

describe('Gmail', () => {
  it('first pull: the mail since --from, one thread per mail thread, no spam, your own mail as "you"', async () => {
    const fetch = network();
    const [report] = await poll(fetch);
    expect(report).toMatchObject({ service: 'gmail', pulled: true, ok: true, added: 3, line: 'Gmail (sam@example.com): 3 new' });
    const list = fetch.calls.find((c) => c.url.pathname.endsWith('/messages'))!;
    expect(list.url.searchParams.get('q')).toBe(`after:${Date.parse('2026-09-01T00:00:00Z') / 1000} -in:drafts -in:chats`);

    const entries = store.allEntries();
    expect(entries.map((e) => [e.threadTitle, e.speaker, e.title])).toEqual([
      ['Picnic plans', 'Ada Example', 'Picnic plans'],
      ['Picnic plans', 'you', 'Re: Picnic plans'],
      ['Your card renews soon', 'Town Library', 'Your card renews soon'],
    ]);
    expect(entries[0]!.sourceLabel).toBe('gmail:sam@example.com');
    expect(entries[0]!.body).toBe('Shall we meet at the lake on Saturday?\nI can bring bread.');
    // The quoted mail under a reply is not read twice.
    expect(entries[1]!.body).toBe("Saturday works. I'll bring cheese.");
    // HTML-only mail as text, without its style sheet; attachments by name.
    expect(entries[2]!.body).toBe('Your card renews on 1 December.\nFees & fines: none.\n\nAttachments: card.pdf');
    expect(findConnection(home, 'gmail')!.cursor).toEqual({ historyId: '1000', pending: [] });
  });

  it('incremental pull: only what Gmail’s history says is new; deleted mail stays in the record and is counted', async () => {
    await poll(network());
    time.add(6);
    history = (call) => {
      expect(call.url.searchParams.get('startHistoryId')).toBe('1000');
      expect(call.url.searchParams.getAll('historyTypes')).toEqual(['messageAdded', 'messageDeleted']);
      return json({
        history: [
          { id: '1003', messagesAdded: [{ message: { id: 'msg-a3', threadId: 'thr-picnic', labelIds: ['INBOX'] } }] },
          { id: '1004', messagesDeleted: [{ message: { id: 'msg-b1', threadId: 'thr-library' } }] },
          { id: '1005', messagesAdded: [{ message: { id: 'msg-draft', threadId: 'thr-picnic', labelIds: ['DRAFT'] } }] },
          { id: '1006', messagesAdded: [{ message: { id: 'msg-gone', threadId: 'thr-x', labelIds: ['INBOX'] } }] },
        ],
        historyId: '1010',
      });
    };
    const fetch = network();
    const [report] = await poll(fetch);
    // msg-b1 deleted in Gmail; msg-gone deleted before it could be read.
    expect(report).toMatchObject({ ok: true, added: 1, deleted: 2, line: 'Gmail (sam@example.com): 1 new, 2 deleted in Gmail (kept here)' });
    expect(fetch.calls.some((c) => c.url.pathname.endsWith('/msg-draft'))).toBe(false);
    expect(fetch.calls.some((c) => c.url.pathname.endsWith('/messages'))).toBe(false);
    const picnic = store.allEntries().filter((e) => e.threadTitle === 'Picnic plans');
    expect(picnic.map((e) => e.body.split('\n')[0])).toEqual(['Shall we meet at the lake on Saturday?', "Saturday works. I'll bring cheese.", 'See you at noon by the boathouse.']);
    expect(store.allEntries().some((e) => e.externalId === 'msg-b1')).toBe(true);
    expect(findConnection(home, 'gmail')!.cursor).toEqual({ historyId: '1010', pending: [] });
  });

  it('waits five minutes between pulls unless forced', async () => {
    await poll(network());
    time.add(2);
    const fetch = network();
    const [report] = await poll(fetch);
    expect(fetch.calls).toHaveLength(0);
    expect(report).toMatchObject({ pulled: false, ok: true, line: 'Gmail (sam@example.com): 3 new · next pull in 3 minutes' });
  });

  it('a rate limit part-way keeps what was read and carries on from there after the wait', async () => {
    // 25 invented messages: the first batch of 20 is read, then Gmail says slow down.
    messages = {};
    listed = [];
    for (let i = 25; i >= 1; i--) {
      const id = `msg-n${i}`;
      messages[id] = {
        id,
        threadId: `thr-n${i}`,
        labelIds: ['INBOX'],
        internalDate: String(Date.parse('2026-11-01T00:00:00Z') + i * 60_000),
        payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: `Note ${i}` }, { name: 'From', value: 'ada@example.org' }], body: { data: Buffer.from(`Note number ${i}`).toString('base64url') } },
      };
      listed.push(id);
    }
    let reads = 0;
    const fetch = network();
    fetch.routes.unshift((call) => {
      if (!/\/messages\/msg-n\d+$/.test(call.url.pathname)) return undefined;
      reads++;
      return reads === 21 ? json({ error: { code: 429 } }, 429, { 'retry-after': '120' }) : undefined;
    });
    const [first] = await poll(fetch);
    expect(first).toMatchObject({ ok: false, failure: 'rate-limited' });
    expect(first!.line).toBe('Gmail (sam@example.com): Gmail asked Skeinwise to slow down; what was read so far is saved, trying again in 2 minutes');
    expect(store.allEntries()).toHaveLength(20);
    expect((findConnection(home, 'gmail')!.cursor as { pending: string[] }).pending).toEqual(['msg-n21', 'msg-n22', 'msg-n23', 'msg-n24', 'msg-n25']);
    expect(findConnection(home, 'gmail')!.nextPollAt).toBe('2026-11-25T12:02:00.000Z');

    time.add(1);
    const early = network();
    await poll(early);
    expect(early.calls).toHaveLength(0);

    time.add(2);
    const later = network();
    const [second] = await poll(later);
    expect(second).toMatchObject({ ok: true, added: 5 });
    expect(later.calls.filter((c) => /\/messages\/msg-n\d+$/.test(c.url.pathname))).toHaveLength(5);
    expect(store.allEntries()).toHaveLength(25);
  });

  it('a revoked token: one clear line, pulls stop until you connect again, nothing crashes', async () => {
    const fetch = network();
    fetch.routes.unshift(
      on('GET', `${API}/profile`, () => json({ error: { code: 401, message: 'Invalid Credentials' } }, 401)),
      on('POST', GOOGLE.tokenUrl, () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)),
    );
    const [report] = await poll(fetch);
    expect(report).toMatchObject({ ok: false, failure: 'signed-out' });
    expect(report!.line).toBe(
      'Gmail (sam@example.com): Gmail signed Skeinwise out (invalid_grant (Token has been expired or revoked.)); connect again. Run: skeinwise connect gmail',
    );
    time.add(60);
    const after = network();
    const [again] = await poll(after);
    expect(after.calls).toHaveLength(0);
    expect(again).toMatchObject({ pulled: false, ok: false, line: report!.line });
  });

  it('renews an expiring token first and keeps the new one in the Keychain only', async () => {
    time.set('2026-11-25T12:59:30.000Z');
    const fetch = network();
    fetch.routes.unshift(on('POST', GOOGLE.tokenUrl, () => json({ access_token: 'test-access-token-2', expires_in: 3600 })));
    const [report] = await poll(fetch);
    expect(report!.ok).toBe(true);
    expect(fetch.calls[0]!.url.toString()).toBe(GOOGLE.tokenUrl);
    expect(fetch.calls[1]!.headers.get('authorization')).toBe('Bearer test-access-token-2');
    const kept = [...keychain.items.values()].map((v) => JSON.parse(v) as { access: string; refresh: string });
    expect(kept).toEqual([{ access: 'test-access-token-2', refresh: 'test-refresh-token', expiresAt: '2026-11-25T13:59:30.000Z' }]);
    const files = allFilesText(home);
    for (const secret of ['test-access-token', 'test-refresh-token']) expect(files).not.toContain(secret);
  });

  it('lists again from the last good pull when Gmail no longer has the history', async () => {
    await poll(network());
    time.add(60 * 24 * 10);
    history = () => json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404);
    listed = ['msg-a3', 'msg-b1', 'msg-a2', 'msg-a1'];
    const fetch = network();
    // Ten days on, the hour-long access token has run out and is renewed first.
    fetch.routes.unshift(on('POST', GOOGLE.tokenUrl, () => json({ access_token: 'test-access-token-2', expires_in: 3600 })));
    const [report] = await poll(fetch);
    expect(report).toMatchObject({ ok: true, added: 1, line: 'Gmail (sam@example.com): 1 new' });
    const list = fetch.calls.find((c) => c.url.pathname.endsWith('/messages'))!;
    expect(list.url.searchParams.get('q')).toBe(`after:${Date.parse('2026-11-25T12:00:00Z') / 1000} -in:drafts -in:chats`);
  });
});

describe('reading a message', () => {
  it('names a thread by its subject without Re: and Fwd:', () => {
    expect(threadTitle('Re: Fwd: RE: Picnic plans')).toBe('Picnic plans');
    expect(threadTitle('')).toBe('(no subject)');
  });

  it('keeps a forwarded message’s text, and drops Outlook’s quoted original', () => {
    expect(dropQuoted('FYI\n\n---------- Forwarded message ---------\nFrom: Ada\nThe plan')).toContain('The plan');
    expect(dropQuoted('Yes.\n\n-----Original Message-----\nFrom: Ada\nShall we?')).toBe('Yes.');
  });

  it('reads text in the part’s own character set', () => {
    const latin1 = Buffer.from('Caf\xe9 at noon', 'latin1').toString('base64url');
    const text = bodyText({ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1' }], body: { data: latin1 } }, []);
    expect(text).toBe('Café at noon');
  });
});
