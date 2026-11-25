// Gmail, read-only: one thread per mail thread, one entry per message. The first pull lists the mail since --from
// (90 days by default); later pulls follow Gmail's history from where the last one stopped. The connector reads
// messages and never sends, deletes, labels or marks one as read. Shapes from the Gmail API v1 reference (users.getProfile,
// users.messages.list/get, users.history.list).

import { isObj, stripHtml } from '../importers/util.ts';
import type { EntryInput, ThreadInput } from '../store/store.ts';
import { type Api, ApiError } from './http.ts';
import { formPost, GOOGLE, GOOGLE_REVOKE_URL } from './oauth.ts';
import type { Connector, PullContext, RevokeContext } from './types.ts';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** Messages fetched per pull; the rest wait in the cursor for the next one. */
const PER_PULL = 100;
/** Messages per ingest, so a stop part-way keeps what was read. */
const PER_BATCH = 20;
/** Mail Skeinwise leaves alone. */
const SKIP_LABELS = new Set(['SPAM', 'TRASH', 'DRAFT', 'CHAT']);

interface GmailCursor {
  /** Gmail's history point the pending list is complete up to. */
  historyId: string;
  /** Message IDs still to read, oldest first. */
  pending: string[];
}

interface Part {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: Part[];
}

interface Message {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
}

export const gmail: Connector = {
  service: 'gmail',
  label: 'Gmail',
  reads: 'your mail since the --from date (90 days back by default), then new mail as it arrives; never spam, trash or drafts',
  scopes: [
    {
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      why: 'read your messages and their labels; it cannot send, delete, label or mark anything',
    },
  ],
  signIn: { kind: 'oauth', provider: GOOGLE },
  async identify(api) {
    const profile = (await api.get(`${BASE}/profile`)) as { emailAddress?: string } | null;
    if (!profile?.emailAddress) throw new Error('Gmail did not say which account this is.');
    return profile.emailAddress;
  },
  pull: pullGmail,
  revoke: googleRevoke,
};

/** Revoking the refresh token ends the whole grant; the access token alone would leave the refresh token working. */
export async function googleRevoke({ token, fetch: fetchFn }: RevokeContext): Promise<void> {
  const res = await formPost(fetchFn, GOOGLE_REVOKE_URL, { token: token.refresh ?? token.access }, 'Google');
  // 400 invalid_token: already revoked or expired, which is what we wanted.
  if (res.status !== 200 && res.status !== 400) throw new Error(`Google answered HTTP ${res.status}`);
}

async function pullGmail(ctx: PullContext): Promise<void> {
  const { api } = ctx;
  let cursor = readCursor(ctx.cursor);
  if (!cursor) {
    cursor = await startFrom(api, ctx.since);
  } else {
    cursor = await followHistory(ctx, cursor);
  }
  ctx.save(cursor);

  // Read what is pending, oldest first, saving after each batch.
  const todo = cursor.pending.slice(0, PER_PULL);
  for (let i = 0; i < todo.length; i += PER_BATCH) {
    const ids = todo.slice(i, i + PER_BATCH);
    const messages: Message[] = [];
    for (const id of ids) {
      try {
        messages.push((await api.get(`${BASE}/messages/${encodeURIComponent(id)}`, { format: 'full' })) as Message);
      } catch (error) {
        // Deleted between the listing and now.
        if (error instanceof ApiError && error.status === 404) ctx.deleted(1);
        else throw error;
      }
    }
    ctx.emit(toThreads(messages, ctx.account));
    const done = new Set(ids);
    cursor = { historyId: cursor.historyId, pending: cursor.pending.filter((id) => !done.has(id)) };
    ctx.save(cursor);
  }
}

function readCursor(raw: unknown): GmailCursor | null {
  if (!isObj(raw) || typeof raw.historyId !== 'string') return null;
  const pending = Array.isArray(raw.pending) ? raw.pending.filter((x): x is string => typeof x === 'string') : [];
  return { historyId: raw.historyId, pending };
}

/** The first pull, or a fresh start when Gmail no longer has the history: every message since `since`. */
async function startFrom(api: Api, since: string): Promise<GmailCursor> {
  const profile = (await api.get(`${BASE}/profile`)) as { historyId?: string } | null;
  if (!profile?.historyId) throw new Error('Gmail sent no history point to start from.');
  const after = Math.floor(Date.parse(since) / 1000);
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = (await api.get(`${BASE}/messages`, {
      q: `after:${after} -in:drafts -in:chats`,
      maxResults: 500,
      pageToken,
    })) as { messages?: { id: string }[]; nextPageToken?: string } | null;
    for (const m of page?.messages ?? []) ids.push(m.id);
    pageToken = page?.nextPageToken;
  } while (pageToken);
  // Gmail lists newest first; read oldest first so threads build up in order.
  return { historyId: profile.historyId, pending: ids.reverse() };
}

async function followHistory(ctx: PullContext, cursor: GmailCursor): Promise<GmailCursor> {
  const pending = [...cursor.pending];
  const queued = new Set(pending);
  let historyId = cursor.historyId;
  let pageToken: string | undefined;
  do {
    let page: {
      history?: { messagesAdded?: { message: Message }[]; messagesDeleted?: { message: Message }[] }[];
      nextPageToken?: string;
      historyId?: string;
    } | null;
    try {
      page = (await ctx.api.get(`${BASE}/history`, {
        startHistoryId: cursor.historyId,
        historyTypes: ['messageAdded', 'messageDeleted'],
        maxResults: 500,
        pageToken,
      })) as typeof page;
    } catch (error) {
      // Gmail keeps about a week of history. Older than that: list again from the last good pull.
      if (error instanceof ApiError && error.status === 404) {
        const fresh = await startFrom(ctx.api, ctx.lastPulledAt ?? ctx.since);
        return { historyId: fresh.historyId, pending: [...new Set([...pending, ...fresh.pending])] };
      }
      throw error;
    }
    for (const h of page?.history ?? []) {
      for (const { message } of h.messagesAdded ?? []) {
        if (message.labelIds?.some((l) => SKIP_LABELS.has(l)) || queued.has(message.id)) continue;
        pending.push(message.id);
        queued.add(message.id);
      }
      for (const { message } of h.messagesDeleted ?? []) {
        ctx.deleted(1);
        if (queued.delete(message.id)) pending.splice(pending.indexOf(message.id), 1);
      }
    }
    if (page?.historyId) historyId = page.historyId;
    pageToken = page?.nextPageToken;
  } while (pageToken);
  return { historyId, pending };
}

/** Messages to threads, grouped by Gmail's thread. */
export function toThreads(messages: Message[], account: string): ThreadInput[] {
  const threads = new Map<string, ThreadInput>();
  for (const m of messages) {
    if (m.labelIds?.some((l) => SKIP_LABELS.has(l))) continue;
    const entry = toEntry(m, account);
    const thread = threads.get(m.threadId) ?? { externalId: m.threadId, title: threadTitle(entry.title ?? ''), entries: [] };
    thread.entries.push(entry);
    threads.set(m.threadId, thread);
  }
  return [...threads.values()];
}

function toEntry(m: Message, account: string): EntryInput & { title: string } {
  const headers = m.payload?.headers ?? [];
  const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  const sentMs = Number(m.internalDate ?? Date.parse(header('date')));
  const createdAt = new Date(Number.isFinite(sentMs) ? sentMs : 0).toISOString();
  const from = parseAddress(header('from'));
  const attachments: string[] = [];
  const text = m.payload ? bodyText(m.payload, attachments) : '';
  let body = dropQuoted(text) || (m.snippet ?? '');
  if (attachments.length) body = `${body}\n\nAttachments: ${attachments.join(', ')}`.trim();
  return {
    externalId: m.id,
    kind: 'message',
    speaker: from.email.toLowerCase() === account.toLowerCase() ? 'you' : from.name || from.email || 'unknown sender',
    title: header('subject') || '(no subject)',
    createdAt,
    body,
    // Threads read in the order the mail was sent.
    seq: Math.floor(Date.parse(createdAt) / 1000),
  };
}

/** "Re: Fwd: Plans" is the thread "Plans". */
export function threadTitle(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|aw|wg)\s*(\[\d+\])?\s*:\s*)+/i, '').trim() || '(no subject)';
}

export function parseAddress(value: string): { name: string; email: string } {
  const angled = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (angled) return { name: angled[1]!.trim(), email: angled[2]!.trim() };
  return { name: '', email: value.trim() };
}

/** The message's own text: the plain part, else the HTML part as text. Attachment names go into `attachments`. */
export function bodyText(part: Part, attachments: string[]): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: Part) => {
    if (p.filename) {
      attachments.push(p.filename);
      return;
    }
    const type = (p.mimeType ?? '').toLowerCase();
    if (type === 'text/plain' && p.body?.data) plain.push(decode(p.body.data, charset(p)));
    else if (type === 'text/html' && p.body?.data) html.push(decode(p.body.data, charset(p)));
    for (const child of p.parts ?? []) walk(child);
  };
  walk(part);
  if (plain.length) return plain.join('\n\n').trim();
  return html.map((h) => stripHtml(h.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ''))).join('\n\n').trim();
}

function charset(p: Part): string {
  const type = p.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  return /charset="?([\w-]+)/i.exec(type)?.[1] ?? 'utf-8';
}

function decode(data: string, label: string): string {
  const bytes = Buffer.from(data, 'base64url');
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** Drops the quoted earlier mail under a reply: "> " lines, the "On ... wrote:" line above them, Outlook's quote. */
export function dropQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // Outlook's reply marker. A forward keeps its text: there it is the message.
  const cut = lines.findIndex((l) => /^-{2,}\s*original message\s*-{2,}$/i.test(l.trim()));
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter((l) => !l.startsWith('>'));
  while (kept.length && /wrote:\s*$/.test(kept[kept.length - 1]!)) kept.pop();
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
