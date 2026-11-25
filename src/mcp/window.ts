// The window server's messages: each tool sends one to the running app, which moves its view while you watch. They go
// as POST http://127.0.0.1:<port>/api/window with the install token from <home>/token in x-skeinwise-token, the same
// guard as every other API call. docs/mcp.md describes the shapes for the app's side.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../errors.ts';
import { getLiveHub } from '../organiser/views.ts';
import type { Store } from '../store/store.ts';
import { AccessError } from './access.ts';
import type { Tool } from './protocol.ts';

/** The port `skeinwise serve` tries first. */
export const WINDOW_PORT = 7319;
/** The brain view's layouts and the legend's groupings, as the app names them. */
export const LAYOUTS = ['brain', 'rings', 'clusters'] as const;
export const GROUPINGS = ['project', 'folder', 'source', 'speaker'] as const;
/** Most entries one message may name. */
export const MAX_WINDOW_ENTRIES = 500;

export type Layout = (typeof LAYOUTS)[number];
export type Grouping = (typeof GROUPINGS)[number];

/** Moves the view to the brain and frames these entries and hubs, lighting them up. */
export interface ShowInBrain {
  type: 'show_in_brain';
  entryIds: number[];
  hubIds: number[];
}

/** Opens one entry in the reader. */
export interface OpenEntry {
  type: 'open_entry';
  entryId: number;
}

/** Opens a hub's panel. */
export interface OpenHub {
  type: 'open_hub';
  hubId: number;
}

/** Switches the brain view's layout, and the legend's grouping when given. */
export interface SetLayout {
  type: 'set_layout';
  layout: Layout;
  grouping?: Grouping;
}

/** Lights up the points matching a search, or these entries, and dims the rest, without moving the view. Neither clears it. */
export interface Highlight {
  type: 'highlight';
  query?: string;
  entryIds?: number[];
}

export type WindowMessage = ShowInBrain | OpenEntry | OpenHub | SetLayout | Highlight;

/** The body of POST /api/window: a message and the agent that sent it. */
export type WindowRequest = WindowMessage & { agent: string };

export interface WindowTarget {
  home: string;
  port: number;
  fetch: typeof fetch;
}

export function readToken(home: string): string {
  const file = join(home, 'token');
  const token = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new UsageError(`There is no install token in ${file} yet. Start the app once with "skeinwise serve", then try again.`);
  }
  return token;
}

/** Sends one message to the app and returns its reply. */
export async function sendWindow(target: WindowTarget, request: WindowRequest): Promise<unknown> {
  const token = readToken(target.home);
  const url = `http://127.0.0.1:${target.port}/api/window`;
  let res: Response;
  try {
    res = await target.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-skeinwise-token': token },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new UsageError(`The Skeinwise app isn't answering on port ${target.port}. Start it with "skeinwise serve", or give its port with --port.`);
  }
  const text = await res.text();
  if (res.status === 423) throw new AccessError('Skeinwise is locked, so its tools are stopped. Unlock it in the app.');
  if (res.status === 401) {
    throw new UsageError(`The app on port ${target.port} refused the install token from ${target.home}: it serves another record folder.`);
  }
  if (res.status === 404 || res.status === 405) throw new UsageError(`The app on port ${target.port} can't move its view yet. Update Skeinwise.`);
  if (!res.ok) throw new UsageError(`The app answered ${res.status}: ${replyError(text)}`);
  return text ? (JSON.parse(text) as unknown) : {};
}

function replyError(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON: the text itself says what went wrong
  }
  return text.trim().slice(0, 200) || 'no reason given';
}

export interface WindowCtx extends WindowTarget {
  store: Store;
  agent: string;
}

const ids = (description: string) => ({ type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: MAX_WINDOW_ENTRIES, description });

function idList(value: unknown, what: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => Number.isInteger(v) && v > 0)) throw new UsageError(`${what} must be a list of ids.`);
  if (value.length > MAX_WINDOW_ENTRIES) throw new UsageError(`Name at most ${MAX_WINDOW_ENTRIES} ${what.toLowerCase()} at once.`);
  return [...new Set(value as number[])];
}

function oneId(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new UsageError(`Give ${what} as a whole number.`);
  return value as number;
}

/** The entries, checked: an id the record doesn't show would leave the app with nothing to point at. */
function entries(ctx: WindowCtx, list: number[]): number[] {
  for (const id of list) if (!ctx.store.visibleEntry(id)) throw new UsageError(`There is no entry ${id} in the record.`);
  return list;
}

function hubs(ctx: WindowCtx, list: number[]): number[] {
  for (const id of list) if (!getLiveHub(ctx.store.db, id)) throw new UsageError(`There is no hub ${id}. list_hubs names them.`);
  return list;
}

async function send(ctx: WindowCtx, message: WindowMessage): Promise<string> {
  const reply = await sendWindow(ctx, { ...message, agent: ctx.agent });
  const note = reply && typeof reply === 'object' && typeof (reply as { message?: unknown }).message === 'string' ? ` ${(reply as { message: string }).message}` : '';
  return `Done.${note}`;
}

export const WINDOW_TOOLS: Tool<WindowCtx>[] = [
  {
    name: 'show_in_brain',
    title: 'Show in the brain',
    description: 'Switch the Skeinwise window to the brain view and frame these entries and hubs, lit up. Use ids from the memory tools.',
    inputSchema: { type: 'object', properties: { entry_ids: ids('Entries to show.'), hub_ids: ids('Hubs to show.') } },
    readOnly: true,
    run: (ctx, a) => {
      const entryIds = entries(ctx, idList(a.entry_ids, 'Entry ids'));
      const hubIds = hubs(ctx, idList(a.hub_ids, 'Hub ids'));
      if (!entryIds.length && !hubIds.length) throw new UsageError('Give at least one entry or hub id to show.');
      return send(ctx, { type: 'show_in_brain', entryIds, hubIds });
    },
  },
  {
    name: 'open_entry',
    title: 'Open an entry',
    description: 'Open one entry in the Skeinwise window\'s reader.',
    inputSchema: { type: 'object', properties: { entry_id: { type: 'integer', minimum: 1 } }, required: ['entry_id'] },
    readOnly: true,
    run: (ctx, a) => send(ctx, { type: 'open_entry', entryId: entries(ctx, [oneId(a.entry_id, 'entry_id')])[0]! }),
  },
  {
    name: 'open_hub',
    title: 'Open a hub',
    description: 'Open a concept hub\'s panel in the Skeinwise window.',
    inputSchema: { type: 'object', properties: { hub_id: { type: 'integer', minimum: 1 } }, required: ['hub_id'] },
    readOnly: true,
    run: (ctx, a) => send(ctx, { type: 'open_hub', hubId: hubs(ctx, [oneId(a.hub_id, 'hub_id')])[0]! }),
  },
  {
    name: 'set_layout',
    title: 'Set the brain layout',
    description: 'Switch the brain view\'s layout (brain, rings for year rings, or clusters) and, if given, what colours the points.',
    inputSchema: {
      type: 'object',
      properties: { layout: { type: 'string', enum: [...LAYOUTS] }, grouping: { type: 'string', enum: [...GROUPINGS] } },
      required: ['layout'],
    },
    readOnly: true,
    run: (ctx, a) => {
      if (!LAYOUTS.includes(a.layout as Layout)) throw new UsageError(`layout must be one of: ${LAYOUTS.join(', ')}.`);
      if (a.grouping !== undefined && !GROUPINGS.includes(a.grouping as Grouping)) throw new UsageError(`grouping must be one of: ${GROUPINGS.join(', ')}.`);
      return send(ctx, { type: 'set_layout', layout: a.layout as Layout, ...(a.grouping ? { grouping: a.grouping as Grouping } : {}) });
    },
  },
  {
    name: 'highlight',
    title: 'Highlight',
    description: 'Light up the points matching a search, or these entries, and dim the rest, without moving the view. Call it with neither to clear.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 200 }, entry_ids: ids('Entries to light up.') } },
    readOnly: true,
    run: (ctx, a) => {
      if (a.query !== undefined && typeof a.query !== 'string') throw new UsageError('query must be text.');
      const query = (a.query as string | undefined)?.trim();
      const entryIds = entries(ctx, idList(a.entry_ids, 'Entry ids'));
      return send(ctx, { type: 'highlight', ...(query ? { query } : {}), ...(entryIds.length ? { entryIds } : {}) });
    },
  },
];
