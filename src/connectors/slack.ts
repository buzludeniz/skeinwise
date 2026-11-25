// Slack, read-only: one thread per channel the person picks, one entry per top-level message. The person makes their
// own Slack app with read scopes only, installs it to their workspace and pastes its User OAuth Token; Skeinwise refuses
// a token that can do more. It never posts, reacts or marks anything as read. Shapes from the Slack Web API reference
// (auth.test, auth.revoke, conversations.list, conversations.history, users.info).

import { UsageError } from '../errors.ts';
import { isObj } from '../importers/util.ts';
import type { EntryInput } from '../store/store.ts';
import type { Api } from './http.ts';
import type { Connector, PullContext } from './types.ts';

const BASE = 'https://slack.com/api';

/** The scopes the person's app asks for; a token with any other is refused. */
export const SLACK_SCOPES = ['channels:history', 'channels:read', 'groups:history', 'groups:read', 'users:read'] as const;

interface Channel {
  id: string;
  name?: string;
  is_archived?: boolean;
}

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  subtype?: string;
  text?: string;
  thread_ts?: string;
  files?: { name?: string; title?: string }[];
}

interface ChannelCursor {
  name: string;
  /** The newest message read so far (Slack's ts); absent before the first pull finishes. */
  latest?: string;
}

interface SlackCursor {
  /** The person's own user ID, so their messages read as "you". */
  self?: string;
  channels: Record<string, ChannelCursor>;
  /** Display names by user ID, so each name is looked up once. */
  users: Record<string, string>;
}

/** Messages that are words someone wrote. Joins, leaves, topic changes and the like are left out. */
const KEPT_SUBTYPES = new Set([undefined, 'bot_message', 'thread_broadcast', 'file_share', 'me_message']);

export const slack: Connector = {
  service: 'slack',
  label: 'Slack',
  reads: 'the messages in the channels you pick, from the --from date on, then new ones as they arrive (not thread replies yet)',
  scopes: [
    { scope: 'channels:history', why: 'read messages in the public channels you pick' },
    { scope: 'channels:read', why: 'find those channels by name' },
    { scope: 'groups:history', why: 'read messages in the private channels you pick (only ones you are in)' },
    { scope: 'groups:read', why: 'find those private channels by name' },
    { scope: 'users:read', why: 'show people by name instead of by ID' },
  ],
  signIn: {
    kind: 'token',
    how: 'Make your own Slack app from the manifest in docs/connectors.md (read scopes only), install it to your workspace, and paste its User OAuth Token (it starts with xoxp-).',
  },
  picks: { flag: 'channels', what: 'channels (names like general, or IDs)' },
  async identify(api) {
    const { body, headers } = await api.getWithHeaders(`${BASE}/auth.test`);
    const scopes = headers.get('x-oauth-scopes');
    if (scopes !== null) checkScopes(scopes.split(',').map((s) => s.trim()).filter(Boolean));
    const who = body as { team?: string; url?: string } | null;
    const team = who?.team || who?.url?.replace(/^https?:\/\/|\.slack\.com\/?$/g, '');
    if (!team) throw new Error('Slack did not say which workspace this is.');
    return team;
  },
  pull: pullSlack,
  async revoke({ api }) {
    await api.get(`${BASE}/auth.revoke`);
  },
};

/** Refuses a token that can do more than read, or can't read what Skeinwise needs. */
export function checkScopes(granted: string[]): void {
  const extra = granted.filter((s) => !(SLACK_SCOPES as readonly string[]).includes(s));
  if (extra.length) {
    throw new UsageError(
      `This token can do more than read (${extra.join(', ')}). Skeinwise takes a token with only these scopes: ${SLACK_SCOPES.join(', ')}. Make the app from the manifest in docs/connectors.md and paste its token. Nothing was connected.`,
    );
  }
  if (!granted.includes('channels:history') && !granted.includes('groups:history')) {
    throw new UsageError(`This token can't read channel history. Give the app these user scopes: ${SLACK_SCOPES.join(', ')}. Nothing was connected.`);
  }
}

/** Finds the picked channels by name or ID among those the person can see. Unknown names stop the connect. */
export async function resolveChannels(api: Api, picks: string[]): Promise<Record<string, ChannelCursor>> {
  const wanted = picks.map((p) => p.replace(/^#/, '').trim()).filter(Boolean);
  if (!wanted.length) throw new UsageError('Pick the channels to read: --channels general,team-notes');
  const found: Record<string, ChannelCursor> = {};
  const left = new Set(wanted);
  let cursor: string | undefined;
  do {
    const page = (await api.get(`${BASE}/conversations.list`, {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    })) as { channels?: Channel[]; response_metadata?: { next_cursor?: string } } | null;
    for (const c of page?.channels ?? []) {
      const key = left.has(c.id) ? c.id : c.name && left.has(c.name) ? c.name : undefined;
      if (!key) continue;
      found[c.id] = { name: c.name ?? c.id };
      left.delete(key);
    }
    cursor = page?.response_metadata?.next_cursor || undefined;
  } while (cursor && left.size);
  if (left.size) {
    throw new UsageError(`Slack has no channel you can read called ${[...left].map((n) => `#${n}`).join(', ')}. Nothing was connected.`);
  }
  return found;
}

function readCursor(raw: unknown): SlackCursor {
  const out: SlackCursor = { channels: {}, users: {} };
  if (!isObj(raw)) return out;
  if (typeof raw.self === 'string') out.self = raw.self;
  if (isObj(raw.channels)) {
    for (const [id, c] of Object.entries(raw.channels)) {
      if (!isObj(c) || typeof c.name !== 'string') continue;
      out.channels[id] = { name: c.name };
      if (typeof c.latest === 'string') out.channels[id].latest = c.latest;
    }
  }
  if (isObj(raw.users)) for (const [id, name] of Object.entries(raw.users)) if (typeof name === 'string') out.users[id] = name;
  return out;
}

async function pullSlack(ctx: PullContext): Promise<void> {
  const { api } = ctx;
  const cursor = readCursor(ctx.cursor);
  if (!cursor.self) cursor.self = ((await api.get(`${BASE}/auth.test`)) as { user_id?: string } | null)?.user_id;
  // Channels picked at connect time; resolved again only if the cursor lost one.
  const missing = ctx.picks.filter((id) => !cursor.channels[id]);
  if (missing.length) Object.assign(cursor.channels, await resolveChannels(api, missing));
  const oldest = (Date.parse(ctx.since) / 1000).toFixed(6);
  for (const id of ctx.picks) {
    const channel = cursor.channels[id]!;
    const after = channel.latest ?? oldest;
    let newest = channel.latest;
    let page: string | undefined;
    do {
      // Slack gives newest first. Each page is saved to the record as it comes; the cursor moves only once the
      // whole channel is read, so a stop part-way reads the same messages again (and changes nothing) next time.
      const reply = (await api.get(`${BASE}/conversations.history`, { channel: id, oldest: after, limit: 200, cursor: page })) as {
        messages?: SlackMessage[];
        response_metadata?: { next_cursor?: string };
      } | null;
      const entries: EntryInput[] = [];
      for (const m of reply?.messages ?? []) {
        if (!newest || Number(m.ts) > Number(newest)) newest = m.ts;
        // Replies inside a thread are left for later; a reply also sent to the channel counts.
        if (!KEPT_SUBTYPES.has(m.subtype) || (m.thread_ts && m.thread_ts !== m.ts && m.subtype !== 'thread_broadcast')) continue;
        const entry = await toEntry(api, m, id, cursor);
        if (entry) entries.push(entry);
      }
      ctx.emit([{ externalId: id, title: `#${channel.name}`, entries }]);
      page = reply?.response_metadata?.next_cursor || undefined;
    } while (page);
    if (newest) channel.latest = newest;
    ctx.save(cursor);
  }
}

async function toEntry(api: Api, m: SlackMessage, channel: string, cursor: SlackCursor): Promise<EntryInput | null> {
  let body = await readable(api, m.text ?? '', cursor);
  const files = (m.files ?? []).map((f) => f.title || f.name).filter(Boolean);
  if (files.length) body = `${body}\n\nFiles: ${files.join(', ')}`.trim();
  if (!body.trim()) return null;
  const ms = Math.round(Number(m.ts) * 1000);
  const speaker =
    m.user && m.user === cursor.self ? 'you' : m.user ? await userName(api, m.user, cursor) : m.bot_profile?.name || m.username || 'a bot';
  return {
    externalId: `${channel}/${m.ts}`,
    kind: 'message',
    speaker,
    createdAt: new Date(ms).toISOString(),
    body,
    seq: Math.floor(ms / 1000),
  };
}

async function userName(api: Api, id: string, cursor: SlackCursor): Promise<string> {
  const known = cursor.users[id];
  if (known) return known;
  const reply = (await api.get(`${BASE}/users.info`, { user: id }).catch(() => null)) as {
    user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
  } | null;
  const u = reply?.user;
  const name = u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || id;
  cursor.users[id] = name;
  return name;
}

/** Slack's markup as plain text: <@U1> as @name, <#C1|general> as #general, <https://x|label> as "label (https://x)". */
export async function readable(api: Api, text: string, cursor: SlackCursor): Promise<string> {
  const ids = [...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!);
  for (const id of new Set(ids)) await userName(api, id, cursor);
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => `@${cursor.users[id] ?? id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, (_m, name: string) => `#${name}`)
    .replace(/<#([CG][A-Z0-9]+)>/g, (_m, id: string) => `#${cursor.channels[id]?.name ?? id}`)
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, (_m, name: string) => name)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_m, word: string) => `@${word}`)
    .replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, (_m, fallback: string) => fallback)
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_m, url: string, label: string) => (label === url ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_m, url: string) => url)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}
