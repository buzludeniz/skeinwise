// Todoist, read-only (scope data:read): one thread per project, one entry per task. Every pull is one call to the Sync
// endpoint with no commands, so it only reads: the first with sync token "*" (everything), later ones with the token it
// returned (only what changed). Shapes from the Todoist API v1 reference (sync, items, projects, user, revoke).

import { isObj } from '../importers/util.ts';
import type { EntryInput, ThreadInput } from '../store/store.ts';
import { formPost, TODOIST } from './oauth.ts';
import type { Connector, PullContext, RevokeContext } from './types.ts';

const SYNC = 'https://api.todoist.com/api/v1/sync';
const REVOKE = 'https://api.todoist.com/api/v1/revoke';

interface TodoistCursor {
  syncToken: string;
  /** Project names by ID, since a later sync sends only the projects that changed. */
  projects: Record<string, string>;
}

interface Item {
  id: string;
  project_id: string;
  content?: string;
  description?: string;
  due?: { date?: string; string?: string; is_recurring?: boolean } | null;
  priority?: number;
  labels?: string[];
  checked?: boolean;
  is_deleted?: boolean;
  added_at?: string;
  completed_at?: string | null;
}

interface SyncReply {
  sync_token?: string;
  projects?: { id: string; name: string; is_deleted?: boolean }[];
  items?: Item[];
  user?: { email?: string; full_name?: string };
}

export const todoist: Connector = {
  service: 'todoist',
  label: 'Todoist',
  reads: 'your projects and tasks, then changes as they happen',
  scopes: [{ scope: 'data:read', why: 'read your projects, tasks and labels; it cannot add, change, complete or delete anything' }],
  signIn: { kind: 'oauth', provider: TODOIST },
  async identify(api) {
    const reply = (await api.postForm(SYNC, { sync_token: '*', resource_types: '["user"]' })) as SyncReply | null;
    const who = reply?.user?.email || reply?.user?.full_name;
    if (!who) throw new Error('Todoist did not say which account this is.');
    return who;
  },
  pull: pullTodoist,
  async revoke({ token, client, fetch: fetchFn }: RevokeContext) {
    if (!client.id || !client.secret) throw new Error('the client ID or secret is missing, so Todoist cannot be asked');
    const basic = Buffer.from(`${client.id}:${client.secret}`).toString('base64');
    const res = await formPost(fetchFn, REVOKE, { token: token.access, token_type_hint: 'access_token' }, 'Todoist', {
      authorization: `Basic ${basic}`,
    });
    if (res.status !== 200 && res.status !== 204) throw new Error(`Todoist answered HTTP ${res.status}`);
  },
};

async function pullTodoist(ctx: PullContext): Promise<void> {
  const cursor = readCursor(ctx.cursor);
  const reply = (await ctx.api.postForm(SYNC, {
    sync_token: cursor.syncToken,
    resource_types: '["projects","items"]',
  })) as SyncReply | null;
  if (!reply?.sync_token) throw new Error('Todoist sent no sync token.');
  const projects = { ...cursor.projects };
  for (const p of reply.projects ?? []) {
    if (p.is_deleted) delete projects[p.id];
    else projects[p.id] = p.name;
  }
  const threads = new Map<string, ThreadInput>();
  for (const item of reply.items ?? []) {
    if (item.is_deleted) {
      ctx.deleted(1);
      continue;
    }
    const thread = threads.get(item.project_id) ?? {
      externalId: item.project_id,
      title: projects[item.project_id] ?? 'A Todoist project',
      entries: [],
    };
    thread.entries.push(toEntry(item));
    threads.set(item.project_id, thread);
  }
  ctx.emit([...threads.values()]);
  ctx.save({ syncToken: reply.sync_token, projects } satisfies TodoistCursor);
}

function readCursor(raw: unknown): TodoistCursor {
  if (!isObj(raw) || typeof raw.syncToken !== 'string') return { syncToken: '*', projects: {} };
  const projects: Record<string, string> = {};
  if (isObj(raw.projects)) for (const [id, name] of Object.entries(raw.projects)) if (typeof name === 'string') projects[id] = name;
  return { syncToken: raw.syncToken, projects };
}

/** Todoist's priority 4 is what its apps call p1. */
const PRIORITY: Record<number, string> = { 4: 'p1', 3: 'p2', 2: 'p3' };

function toEntry(item: Item): EntryInput {
  const content = item.content?.trim() || '(empty task)';
  const lines = [content];
  if (item.description?.trim()) lines.push(item.description.trim());
  if (item.due?.date) lines.push(`Due: ${item.due.date}${item.due.is_recurring && item.due.string ? ` (${item.due.string})` : ''}`);
  const priority = PRIORITY[item.priority ?? 1];
  if (priority) lines.push(`Priority: ${priority}`);
  if (item.labels?.length) lines.push(`Labels: ${item.labels.join(', ')}`);
  if (item.checked) lines.push(`Done${item.completed_at ? ` ${item.completed_at.slice(0, 10)}` : ''}`);
  const added = item.added_at && !Number.isNaN(Date.parse(item.added_at)) ? new Date(item.added_at).toISOString() : new Date(0).toISOString();
  return {
    externalId: item.id,
    kind: 'message',
    speaker: 'you',
    title: content.split('\n')[0]!.slice(0, 120),
    createdAt: added,
    body: lines.join('\n'),
    seq: Math.floor(Date.parse(added) / 1000),
  };
}
