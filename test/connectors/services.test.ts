// Google Calendar, Todoist and Slack through pollConnectors, the way `skeinwise live` runs them: a first pull, an
// incremental pull, a deleted item, a rate limit and a revoked token, all on invented data and a fake network.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { when } from '../../src/connectors/calendar.ts';
import { TODOIST } from '../../src/connectors/oauth.ts';
import { pollConnectors } from '../../src/connectors/poll.ts';
import { findConnection } from '../../src/connectors/state.ts';
import type { Store } from '../../src/store/store.ts';
import { type Call, type Clock, clock, FakeKeychain, fakeFetch, fixture, json, on, seedConnection, tempHome } from './helpers.ts';
import { keyShaped } from '../samples.ts';

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

const poll = (fetch: typeof globalThis.fetch, force = false) => pollConnectors(store, home, { fetch, keychain, now: time.now, platform: 'darwin', force });
const bodies = () => store.allEntries().map((e) => e.body);

describe('Google Calendar', () => {
  type Page = { items: unknown[]; nextPageToken?: string; nextSyncToken?: string };
  const CAL = fixture<{ calendar: { id: string; summary: string }; page1: Page; page2: Page; changes: Page }>('calendar-events.json');
  const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  let events: (call: Call) => Response;

  const network = () =>
    fakeFetch([
      on('GET', 'https://www.googleapis.com/calendar/v3/calendars/primary', () => json(CAL.calendar)),
      on('GET', EVENTS, (call) => events(call)),
    ]);

  const firstListing = (call: Call) => {
    if (call.url.searchParams.has('syncToken')) return json(CAL.changes);
    return json(call.url.searchParams.get('pageToken') === 'page-2' ? CAL.page2 : CAL.page1);
  };

  beforeEach(async () => {
    events = firstListing;
    await seedConnection(
      home,
      keychain,
      { service: 'calendar', account: 'sam@example.com', clientId: 'test-client.apps.example', picks: ['primary'] },
      { access: 'test-access-token', refresh: 'test-refresh-token', expiresAt: '2026-11-25T13:00:00.000Z' },
    );
  });

  it('first pull: every page of events from --from on, one thread for the calendar', async () => {
    const fetch = network();
    const [report] = await poll(fetch);
    expect(report).toMatchObject({ ok: true, added: 3, line: 'Google Calendar (sam@example.com): 3 new' });
    const first = fetch.calls.find((c) => c.url.pathname.endsWith('/events'))!;
    expect(first.url.searchParams.get('timeMin')).toBe('2026-09-01T00:00:00.000Z');
    expect(first.url.searchParams.get('maxResults')).toBe('250');

    const entries = store.allEntries();
    expect(new Set(entries.map((e) => e.threadTitle))).toEqual(new Set(['Sam Example']));
    expect(entries.map((e) => [e.title, e.speaker])).toEqual([
      ['Long weekend', 'you'],
      ['Dentist', 'you'],
      ['Team lunch', 'Ada Example'],
    ]);
    expect(entries[0]!.body).toBe('Long weekend\nWhen: 2026-12-24 to 2026-12-26 (all day)');
    expect(entries[1]!.body).toBe('Dentist\nWhen: 2026-11-26 09:00 to 09:30 (America/Edmonton)');
    // You and meeting rooms are not listed among the people.
    expect(entries[2]!.body).toMatch(/^Team lunch\nWhen: 2026-11-27 12:00 to 13:00\nWhere: Corner Cafe\nWith: Ada Example\n\nBring the garden plan\.?$/);
    expect(findConnection(home, 'calendar')!.cursor).toEqual({ calendars: { primary: { title: 'Sam Example', syncToken: 'cal-sync-1' } } });
  });

  it('incremental pull: a moved event is a new version, a cancelled one is counted and kept, a new one is added', async () => {
    await poll(network());
    time.add(5);
    const fetch = network();
    const [report] = await poll(fetch);
    expect(report).toMatchObject({ ok: true, added: 1, versioned: 1, deleted: 1 });
    expect(report!.line).toBe('Google Calendar (sam@example.com): 1 new, 1 changed, 1 deleted in Google Calendar (kept here)');
    const call = fetch.calls.find((c) => c.url.pathname.endsWith('/events'))!;
    expect(call.url.searchParams.get('syncToken')).toBe('cal-sync-1');
    expect(call.url.searchParams.has('timeMin')).toBe(false);
    expect(fetch.calls.some((c) => c.url.pathname.endsWith('/calendars/primary'))).toBe(false);

    const lunch = store.allEntries().find((e) => e.title === 'Team lunch')!;
    expect(lunch.version).toBe(2);
    expect(lunch.body).toContain('When: 2026-11-27 12:30 to 13:30');
    expect(bodies()).toContainEqual(expect.stringContaining('Repeats: FREQ=WEEKLY;BYDAY=TH'));
    expect(store.allEntries().some((e) => e.title === 'Long weekend')).toBe(true);
    expect(findConnection(home, 'calendar')!.cursor).toEqual({ calendars: { primary: { title: 'Sam Example', syncToken: 'cal-sync-2' } } });
  });

  it('lists everything again when Google says the sync token is gone (410), changing nothing already read', async () => {
    await poll(network());
    time.add(5);
    events = (call) => (call.url.searchParams.has('syncToken') ? json({ error: { code: 410, message: 'Sync token is no longer valid.' } }, 410) : firstListing(call));
    const [report] = await poll(network());
    expect(report).toMatchObject({ ok: true, added: 0, versioned: 0, line: 'Google Calendar (sam@example.com): nothing new' });
    expect(store.allEntries()).toHaveLength(3);
    expect(findConnection(home, 'calendar')!.cursor).toEqual({ calendars: { primary: { title: 'Sam Example', syncToken: 'cal-sync-1' } } });
  });

  it('a rate limit between pages keeps the first page and carries on from the second', async () => {
    events = (call) =>
      call.url.searchParams.get('pageToken') === 'page-2'
        ? json({ error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } }, 403)
        : firstListing(call);
    const [first] = await poll(network());
    expect(first).toMatchObject({ ok: false, failure: 'rate-limited' });
    expect(first!.line).toBe(
      'Google Calendar (sam@example.com): Google Calendar asked Skeinwise to slow down; what was read so far is saved, trying again in 1 minute',
    );
    expect(store.allEntries()).toHaveLength(2);
    expect(findConnection(home, 'calendar')!.cursor).toEqual({ calendars: { primary: { title: 'Sam Example', pageToken: 'page-2' } } });

    time.add(1);
    events = firstListing;
    const fetch = network();
    const [second] = await poll(fetch);
    expect(second).toMatchObject({ ok: true, added: 1 });
    expect(fetch.calls.filter((c) => c.url.pathname.endsWith('/events')).map((c) => c.url.searchParams.get('pageToken'))).toEqual(['page-2']);
    expect(findConnection(home, 'calendar')!.cursor).toEqual({ calendars: { primary: { title: 'Sam Example', syncToken: 'cal-sync-1' } } });
  });

  it('writes event times plainly', () => {
    expect(when({ date: '2026-11-24' }, { date: '2026-11-25' })).toBe('2026-11-24 (all day)');
    expect(when({ dateTime: '2026-11-24T23:00:00+01:00' }, { dateTime: '2026-11-25T01:00:00+01:00' })).toBe('2026-11-24 23:00 to 2026-11-25 01:00');
  });
});

describe('Todoist', () => {
  type Sync = { user: unknown; full: unknown; changes: unknown };
  const TD = fixture<Sync>('todoist-sync.json');
  const SYNC = 'https://api.todoist.com/api/v1/sync';
  let sync: (call: Call) => Response;

  const network = () => fakeFetch([on('POST', SYNC, (call) => sync(call))]);
  const normal = (call: Call) => {
    const form = new URLSearchParams(call.body);
    expect(form.get('resource_types')).toBe('["projects","items"]');
    // A read: no commands are ever sent.
    expect(form.has('commands')).toBe(false);
    return json(form.get('sync_token') === '*' ? TD.full : TD.changes);
  };

  beforeEach(async () => {
    sync = normal;
    await seedConnection(
      home,
      keychain,
      { service: 'todoist', account: 'sam@example.com', clientId: 'test-todoist-client', port: 8735 },
      { access: 'test-todoist-token', refresh: 'test-todoist-refresh', expiresAt: '2026-11-25T14:00:00.000Z' },
      'test-todoist-secret',
    );
  });

  it('first pull: every task, one thread per project', async () => {
    const fetch = network();
    const [report] = await poll(fetch);
    expect(report).toMatchObject({ ok: true, added: 3, line: 'Todoist (sam@example.com): 3 new' });
    expect(fetch.calls[0]!.headers.get('authorization')).toBe('Bearer test-todoist-token');
    expect(store.allEntries().map((e) => [e.threadTitle, e.speaker, e.body])).toEqual([
      ['Garden', 'you', 'Water the beds\nDue: 2026-11-26 (every day)'],
      ['Garden', 'you', 'Buy tomato seeds\nThe striped kind\nDue: 2026-11-28\nPriority: p1\nLabels: errands'],
      ['Inbox', 'you', 'Call the plumber\nPriority: p3'],
    ]);
    expect(store.allEntries()[0]!.sourceLabel).toBe('todoist:sam@example.com');
    expect(findConnection(home, 'todoist')!.cursor).toEqual({ syncToken: 'td-1', projects: { 'prj-inbox': 'Inbox', 'prj-garden': 'Garden' } });
  });

  it('incremental pull: a completed task is a new version, a deleted one is counted and kept, a new one is added', async () => {
    await poll(network());
    time.add(5);
    const fetch = network();
    const [report] = await poll(fetch);
    expect(new URLSearchParams(fetch.calls[0]!.body).get('sync_token')).toBe('td-1');
    expect(report!.line).toBe('Todoist (sam@example.com): 1 new, 1 changed, 1 deleted in Todoist (kept here)');
    const seeds = store.allEntries().find((e) => e.externalId === 'task-seeds')!;
    expect(seeds.version).toBe(2);
    expect(seeds.body.endsWith('Done 2026-11-25')).toBe(true);
    // The project name comes from what the first pull saved; the change sent no projects.
    expect(store.allEntries().find((e) => e.externalId === 'task-compost')!.threadTitle).toBe('Garden');
    expect(store.allEntries().some((e) => e.externalId === 'task-plumber')).toBe(true);
    expect(findConnection(home, 'todoist')!.cursor).toMatchObject({ syncToken: 'td-2' });
  });

  it('a rate limit reads nothing, keeps the sync token, and tries again after Retry-After', async () => {
    sync = () => json({ error: 'Too many requests' }, 429, { 'retry-after': '600' });
    const [report] = await poll(network());
    expect(report!.line).toBe('Todoist (sam@example.com): Todoist asked Skeinwise to slow down; what was read so far is saved, trying again in 10 minutes');
    expect(findConnection(home, 'todoist')!.cursor).toBeNull();
    time.add(10);
    sync = normal;
    const [again] = await poll(network());
    expect(again).toMatchObject({ ok: true, added: 3 });
  });

  it('a revoked token: Todoist refuses the renewal too, so pulls stop with "connect again"', async () => {
    sync = () => json({ error: 'Unauthorized' }, 401);
    const fetch = network();
    fetch.routes.push(on('POST', TODOIST.tokenUrl, () => json({ error: 'invalid_grant' }, 400)));
    const [report] = await poll(fetch);
    expect(report).toMatchObject({ ok: false, failure: 'signed-out' });
    expect(report!.line).toBe('Todoist (sam@example.com): Todoist signed Skeinwise out (invalid_grant); connect again. Run: skeinwise connect todoist');
    const renewal = new URLSearchParams(fetch.calls.find((c) => c.url.toString() === TODOIST.tokenUrl)!.body);
    expect(renewal.get('client_secret')).toBe('test-todoist-secret');
    expect(findConnection(home, 'todoist')!.nextPollAt).toBeUndefined();
  });
});

describe('Slack', () => {
  type Reply = Record<string, unknown>;
  const SL = fixture<{ authTest: Reply; channels: Reply; users: Record<string, Reply>; plantsPage1: Reply; plantsPage2: Reply; plantsNew: Reply }>('slack.json');
  const API = 'https://slack.com/api';
  let history: (call: Call) => Response;

  const network = () =>
    fakeFetch([
      on('GET', `${API}/auth.test`, () => json(SL.authTest, 200, { 'x-oauth-scopes': 'channels:history,channels:read,groups:history,groups:read,users:read' })),
      on('GET', `${API}/users.info`, (call) => json(SL.users[call.url.searchParams.get('user')!] ?? { ok: false, error: 'user_not_found' })),
      on('GET', `${API}/conversations.history`, (call) => history(call)),
    ]);

  const firstRead = (call: Call) => {
    expect(call.url.searchParams.get('channel')).toBe('C0PLANTS');
    if (call.url.searchParams.get('oldest') !== (Date.parse('2026-09-01T00:00:00Z') / 1000).toFixed(6)) return json(SL.plantsNew);
    return json(call.url.searchParams.get('cursor') === 'plants-2' ? SL.plantsPage2 : SL.plantsPage1);
  };

  beforeEach(async () => {
    history = firstRead;
    // As `connect` leaves it: the picked channel resolved to its ID and name.
    await seedConnection(
      home,
      keychain,
      { service: 'slack', account: 'Garden Club', picks: ['C0PLANTS'], cursor: { channels: { C0PLANTS: { name: 'plants' } }, users: {} } },
      { access: keyShaped('xo', 'xp-test-not-a-real-token') },
    );
  });

  it('first pull: the picked channel’s messages as plain text, your own as "you", no joins and no thread replies', async () => {
    const fetch = network();
    const [report] = await poll(fetch);
    expect(report).toMatchObject({ ok: true, added: 2, line: 'Slack (Garden Club): 2 new' });
    const entries = store.allEntries();
    expect(entries.map((e) => [e.threadTitle, e.speaker, e.body])).toEqual([
      ['#plants', 'Ada', '@Sam the tomatoes are in! Photos: the album (https://photos.example/tomatoes), see #general'],
      ['#plants', 'you', 'Lovely. I will bring stakes & twine.'],
    ]);
    expect(entries[0]!.sourceLabel).toBe('slack:Garden Club');
    expect(fetch.calls.filter((c) => c.url.pathname.endsWith('/users.info'))).toHaveLength(2);
    expect(findConnection(home, 'slack')!.cursor).toEqual({
      self: 'U0SAM',
      channels: { C0PLANTS: { name: 'plants', latest: '1795518000.000300' } },
      users: { U0SAM: 'Sam', U0ADA: 'Ada' },
    });
    // Read calls only: nothing that posts, reacts or marks as read.
    for (const c of fetch.calls) expect(c.url.pathname).toMatch(/\/(auth\.test|users\.info|conversations\.history)$/);
  });

  it('incremental pull: only messages after the newest one read, and names are looked up once', async () => {
    await poll(network());
    time.add(5);
    const fetch = network();
    const [report] = await poll(fetch);
    expect(report).toMatchObject({ ok: true, added: 1 });
    const call = fetch.calls.find((c) => c.url.pathname.endsWith('/conversations.history'))!;
    expect(call.url.searchParams.get('oldest')).toBe('1795518000.000300');
    expect(fetch.calls.some((c) => c.url.pathname.endsWith('/users.info') || c.url.pathname.endsWith('/auth.test'))).toBe(false);
    expect(store.allEntries().at(-1)).toMatchObject({ speaker: 'Weather', body: 'Frost tonight: cover the beds.' });
  });

  it('a rate limit part-way through a channel keeps the page read and reads the channel again next time', async () => {
    history = (call) => (call.url.searchParams.get('cursor') === 'plants-2' ? json({ ok: false, error: 'ratelimited' }, 200, { 'retry-after': '30' }) : firstRead(call));
    const [first] = await poll(network());
    expect(first).toMatchObject({ ok: false, failure: 'rate-limited' });
    expect(first!.line).toBe('Slack (Garden Club): Slack asked Skeinwise to slow down; what was read so far is saved, trying again in 1 minute');
    expect(store.allEntries()).toHaveLength(1);
    expect((findConnection(home, 'slack')!.cursor as { channels: Record<string, unknown> }).channels).toEqual({ C0PLANTS: { name: 'plants' } });

    time.add(1);
    history = firstRead;
    const [second] = await poll(network());
    expect(second).toMatchObject({ ok: true, added: 1 });
    expect(store.allEntries()).toHaveLength(2);
  });

  it('a revoked token: one clear line, and no more pulls until you connect again', async () => {
    const fetch = fakeFetch([on('GET', `${API}/auth.test`, () => json({ ok: false, error: 'token_revoked' }))]);
    const [report] = await poll(fetch);
    expect(report).toMatchObject({ ok: false, failure: 'signed-out' });
    expect(report!.line).toBe('Slack (Garden Club): Slack signed Skeinwise out (the access was revoked or ran out); connect again. Run: skeinwise connect slack');
    time.add(30);
    const later = network();
    await poll(later);
    expect(later.calls).toHaveLength(0);
  });
});

describe('every connection in one poll', () => {
  it('one service’s trouble is its own line; the others still pull', async () => {
    await seedConnection(home, keychain, { service: 'slack', account: 'Garden Club', picks: ['C0PLANTS'], cursor: { channels: { C0PLANTS: { name: 'plants' } }, users: {} } }, { access: keyShaped('xo', 'xp-test') });
    await seedConnection(home, keychain, { service: 'todoist', account: 'sam@example.com', clientId: 'c' }, { access: 'test-todoist-token' }, 's');
    const fetch = fakeFetch([
      on('GET', 'https://slack.com/api/auth.test', () => {
        throw new TypeError('fetch failed');
      }),
      on('POST', 'https://api.todoist.com/api/v1/sync', () => json({ sync_token: 'td-1', projects: [], items: [] })),
    ]);
    const reports = await poll(fetch);
    expect(reports.map((r) => [r.service, r.ok, r.line])).toEqual([
      ['slack', false, "Slack (Garden Club): couldn't reach Slack: fetch failed; trying again in 5 minutes"],
      ['todoist', true, 'Todoist (sam@example.com): nothing new'],
    ]);
  });

  it('says connectors are macOS-only elsewhere, and pulls nothing', async () => {
    await seedConnection(home, keychain, { service: 'todoist', account: 'sam@example.com', clientId: 'c' }, { access: 'test-todoist-token' }, 's');
    const fetch = fakeFetch([]);
    const reports = await pollConnectors(store, home, { fetch, keychain, now: time.now, platform: 'linux' });
    expect(reports[0]!.line).toBe('Todoist (sam@example.com): not pulled, connectors work only on macOS for now');
    expect(fetch.calls).toHaveLength(0);
  });

  it('skips a connection whose source was left out', async () => {
    await seedConnection(home, keychain, { service: 'todoist', account: 'sam@example.com', clientId: 'c' }, { access: 'test-todoist-token' }, 's');
    const fetch = fakeFetch([on('POST', 'https://api.todoist.com/api/v1/sync', () => json(fixture<{ full: unknown }>('todoist-sync.json').full))]);
    await poll(fetch);
    const source = store.sources().find((s) => s.kind === 'todoist')!;
    store.setSourceStatus(source.id, 'out');
    time.add(10);
    const later = fakeFetch([]);
    const [report] = await poll(later);
    expect(report!.line).toBe(`Todoist (sam@example.com): left out, so not pulled (skeinwise include ${source.id} to read it again)`);
    expect(later.calls).toHaveLength(0);
  });
});
