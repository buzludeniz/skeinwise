// The memory server's tools. Each one calls the store's, the notes' or the organiser's own functions; nothing here
// reads or writes the record another way. Reads see only what the record shows (included sources, threads not marked
// "not mine"); writes are versions or runs under the agent's name.

import { relative } from 'node:path';
import { loadConfig } from '../config.ts';
import { UsageError } from '../errors.ts';
import { appendDailyNote, readNotes, writeAgentNote } from '../notes.ts';
import { ask } from '../organiser/ask.ts';
import { RecordView } from '../organiser/record.ts';
import { getRun, undoRun } from '../organiser/runs.ts';
import { getLiveHub, type HubItem, type HubSections, hubEntryIds, hubsOfEntry, liveHubs } from '../organiser/views.ts';
import type { Entry, Store } from '../store/store.ts';
import type { JsonSchema, Tool } from './protocol.ts';
import { AGENT_ENGINE, AGENT_SCHEMA, MAX_TAGGED, tagAsAgent } from './tags.ts';

export interface MemoryCtx {
  store: Store;
  home: string;
  /** The allowed agent's name, as the access file spells it. */
  agent: string;
  now: () => string;
}

export const INSTRUCTIONS = [
  "Skeinwise holds the user's own record: their notes and their chats with AI assistants, each entry dated and kept",
  'with every version. Search or ask before answering from memory, and cite entries by id and date. Your writes are',
  "saved under your name: write_note makes or updates a note of your own, append_daily_note adds a line to today's note,",
  `and tag_entries tags entries in "${AGENT_SCHEMA}" unless you name another schema. undo_run takes back a run you made.`,
].join(' ');

// Arguments

function text(a: Record<string, unknown>, key: string, max: number, required: true): string;
function text(a: Record<string, unknown>, key: string, max: number, required?: false): string | undefined;
function text(a: Record<string, unknown>, key: string, max: number, required = false): string | undefined {
  const v = a[key];
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim() && !required)) {
    if (required) throw new UsageError(`Give ${key}.`);
    return undefined;
  }
  if (typeof v !== 'string') throw new UsageError(`${key} must be text.`);
  if (v.length > max) throw new UsageError(`${key} is too long: keep it under ${max} characters.`);
  return v;
}

function int(a: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = a[key];
  if (v === undefined || v === null) return fallback;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new UsageError(`${key} must be a whole number from ${min} to ${max}.`);
  return v as number;
}

function id(a: Record<string, unknown>, key: string): number {
  const v = a[key];
  if (!Number.isInteger(v) || (v as number) < 1) throw new UsageError(`Give ${key} as a whole number.`);
  return v as number;
}

/** A date or time; a bare day reaches to the end of that day when it closes a span. */
function when(a: Record<string, unknown>, key: string, end: boolean): string | undefined {
  const v = text(a, key, 40);
  if (v === undefined) return undefined;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
  const t = Date.parse(v.trim());
  if (Number.isNaN(t)) throw new UsageError(`${key} must be a date like 2026-11-25 or a time like 2026-11-25T09:00:00Z.`);
  if (day) return `${v.trim()}${end ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`;
  return new Date(t).toISOString();
}

// Shapes

const integer = (description: string, extra: JsonSchema = {}) => ({ type: 'integer', minimum: 1, description, ...extra });
const string = (description: string, extra: JsonSchema = {}) => ({ type: 'string', description, ...extra });
const FILTERS = {
  speaker: string('Only entries by this speaker: "you", "assistant", or a person\'s name.'),
  source: string('Only entries from this kind of source, for example "claude", "chatgpt" or "notes".'),
  from: string('Only entries made on or after this date (YYYY-MM-DD or an ISO time).'),
  to: string('Only entries made on or before this date (YYYY-MM-DD or an ISO time).'),
};

function summary(e: Entry) {
  return {
    id: e.id,
    date: e.createdAt,
    speaker: e.speaker,
    kind: e.kind,
    source: e.sourceLabel,
    title: e.title,
    thread: e.threadId === null ? null : { id: e.threadId, title: e.threadTitle },
  };
}

function excerpt(body: string, chars = 300): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > chars ? `${flat.slice(0, chars - 1)}…` : flat;
}

function visibleEntry(store: Store, entryId: number): Entry {
  const entry = store.visibleEntry(entryId);
  if (!entry) throw new UsageError(`There is no entry ${entryId} in the record.`);
  return entry;
}

/** A hub's bullets, without any that quote an entry the record no longer shows. */
function visibleSections(store: Store, sections: HubSections): Record<keyof HubSections, HubItem[]> {
  const keep = (items: HubItem[]) => items.filter((i) => store.visibleEntry(i.entryId));
  return { in_short: keep(sections.in_short), what_you_found: keep(sections.what_you_found), open_ends: keep(sections.open_ends) };
}

// Tools

export const MEMORY_TOOLS: Tool<MemoryCtx>[] = [
  {
    name: 'search',
    title: 'Search the record',
    description:
      "Full-text search of the user's notes and AI chats, best matches first, the user's own words weighted above assistants'. Returns entry ids, dates and a snippet; read_entry gives the whole text.",
    inputSchema: {
      type: 'object',
      properties: { query: string('Words to look for.'), limit: integer('How many hits (default 10).', { maximum: 50 }), ...FILTERS },
      required: ['query'],
    },
    readOnly: true,
    run: (ctx, a) => {
      const query = text(a, 'query', 500, true);
      readNotes(ctx.store, ctx.home);
      const hits = ctx.store.search(query, {
        limit: int(a, 'limit', 10, 1, 50),
        speaker: text(a, 'speaker', 100),
        sourceKind: text(a, 'source', 50),
        from: when(a, 'from', false),
        to: when(a, 'to', true),
      });
      return { query, hits: hits.map((h) => ({ ...summary(h), snippet: h.snippet })) };
    },
  },
  {
    name: 'ask',
    title: 'Ask the record',
    description:
      'Answer a question from the user\'s own entries, for example "when did I first mention sourdough?" or "what did I decide about the garden?". Returns the matching entries with a dated quote each; you write the answer from them.',
    inputSchema: {
      type: 'object',
      properties: { question: string('The question, in plain words.'), limit: integer('How many entries (default 10).', { maximum: 30 }) },
      required: ['question'],
    },
    readOnly: true,
    run: async (ctx, a) => {
      const question = text(a, 'question', 500, true);
      readNotes(ctx.store, ctx.home);
      const result = await ask(ctx.store, new RecordView(ctx.store), question, {
        engine: 'none',
        budget: loadConfig(ctx.home).budget,
        limit: int(a, 'limit', 10, 1, 30),
      });
      return { question, kind: result.kind, topic: result.topic, hits: result.hits, message: result.message };
    },
  },
  {
    name: 'read_entry',
    title: 'Read an entry',
    description: 'The whole text of one entry, with who made each of its versions and the hubs it belongs to.',
    inputSchema: { type: 'object', properties: { entry_id: integer('The entry.') }, required: ['entry_id'] },
    readOnly: true,
    run: (ctx, a) => {
      const entry = visibleEntry(ctx.store, id(a, 'entry_id'));
      return {
        ...summary(entry),
        body: entry.body,
        versions: ctx.store.history(entry.id).map((v) => ({ version: v.version, editor: v.editor, date: v.editedAt })),
        hubs: hubsOfEntry(ctx.store.db, entry.id),
      };
    },
  },
  {
    name: 'read_thread',
    title: 'Read a thread',
    description: 'The messages of one conversation in order, a page at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: integer('The thread (from an entry\'s thread.id).'),
        offset: { type: 'integer', minimum: 0, description: 'Messages to skip (default 0).' },
        limit: integer('How many messages (default 50).', { maximum: 200 }),
      },
      required: ['thread_id'],
    },
    readOnly: true,
    run: (ctx, a) => {
      const threadId = id(a, 'thread_id');
      const thread = ctx.store.visibleThread(threadId);
      if (!thread) throw new UsageError(`There is no thread ${threadId} in the record.`);
      const offset = int(a, 'offset', 0, 0, 1_000_000);
      const limit = int(a, 'limit', 50, 1, 200);
      const all = ctx.store.threadEntries(threadId);
      const page = all.slice(offset, offset + limit);
      return {
        thread: { id: thread.id, title: thread.title, started: thread.startedAt, messages: all.length },
        offset,
        messages: page.map((e) => ({ id: e.id, date: e.createdAt, speaker: e.speaker, body: e.body })),
        next_offset: offset + page.length < all.length ? offset + page.length : null,
      };
    },
  },
  {
    name: 'timeline',
    title: 'Timeline',
    description: 'Entries in date order within a span, oldest first (or newest first), with an excerpt of each.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILTERS,
        newest_first: { type: 'boolean', description: 'Newest first instead of oldest first.' },
        offset: { type: 'integer', minimum: 0, description: 'Entries to skip (default 0).' },
        limit: integer('How many entries (default 20).', { maximum: 100 }),
      },
    },
    readOnly: true,
    run: (ctx, a) => {
      readNotes(ctx.store, ctx.home);
      const offset = int(a, 'offset', 0, 0, 1_000_000);
      const limit = int(a, 'limit', 20, 1, 100);
      const entries = ctx.store.timeline({
        from: when(a, 'from', false),
        to: when(a, 'to', true),
        speaker: text(a, 'speaker', 100),
        sourceKind: text(a, 'source', 50),
        newest: a.newest_first === true,
        offset,
        limit,
      });
      return { offset, entries: entries.map((e) => ({ ...summary(e), excerpt: excerpt(e.body) })), next_offset: entries.length === limit ? offset + limit : null };
    },
  },
  {
    name: 'list_hubs',
    title: 'List hubs',
    description: "The concept hubs the organiser found in the user's entries, with how many entries each holds and its short summary.",
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    run: (ctx) => ({
      hubs: liveHubs(ctx.store.db).map((h) => ({ id: h.id, name: h.name, entries: h.entries, in_short: visibleSections(ctx.store, h.sections).in_short.map((i) => i.text) })),
    }),
  },
  {
    name: 'read_hub',
    title: 'Read a hub',
    description: "One concept hub: the organiser's reading of the user's entries (not their words), each point citing a dated entry.",
    inputSchema: { type: 'object', properties: { hub_id: integer('The hub.') }, required: ['hub_id'] },
    readOnly: true,
    run: (ctx, a) => {
      const hubId = id(a, 'hub_id');
      const hub = getLiveHub(ctx.store.db, hubId);
      if (!hub) throw new UsageError(`There is no hub ${hubId}. list_hubs names them.`);
      return {
        id: hub.id,
        name: hub.name,
        run: hub.runId,
        sections: visibleSections(ctx.store, hub.sections),
        entry_ids: hubEntryIds(ctx.store.db, hub.id).filter((e) => ctx.store.visibleEntry(e)),
      };
    },
  },
  {
    name: 'write_note',
    title: 'Write a note',
    description:
      'Start a note under your name, or give new text to a note you started (the same title). It can\'t change the user\'s notes or another agent\'s. Each save is a version under your name.',
    inputSchema: {
      type: 'object',
      properties: { title: string('The note\'s title; it also names the file.', { maxLength: 200 }), body: string('The note\'s text, in Markdown.', { maxLength: 100_000 }) },
      required: ['title', 'body'],
    },
    readOnly: false,
    run: (ctx, a) => {
      const write = writeAgentNote(ctx.store, ctx.home, ctx.agent, text(a, 'title', 200, true), text(a, 'body', 100_000, true), new Date(ctx.now()));
      return { entry_id: write.entryId, file: relative(ctx.home, write.path), created: write.created, version: ctx.store.getEntry(write.entryId)!.version };
    },
  },
  {
    name: 'append_daily_note',
    title: "Add to today's note",
    description: "Add a line to the user's daily note for today, starting with your name. The save is a version under your name.",
    inputSchema: { type: 'object', properties: { text: string('The line to add.', { maxLength: 10_000 }) }, required: ['text'] },
    readOnly: false,
    run: (ctx, a) => {
      const write = appendDailyNote(ctx.store, ctx.home, text(a, 'text', 10_000, true), new Date(ctx.now()), ctx.agent);
      return { entry_id: write.entryId, file: relative(ctx.home, write.path), created: write.created, version: ctx.store.getEntry(write.entryId)!.version };
    },
  },
  {
    name: 'tag_entries',
    title: 'Tag entries',
    description: `Give entries a tag. The tags go in the "${AGENT_SCHEMA}" schema unless you name another (Moods or one of the user's own). The tagging is one run under your name; undo_run takes it back.`,
    inputSchema: {
      type: 'object',
      properties: {
        entry_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: MAX_TAGGED, description: 'The entries to tag.' },
        tag: string('The tag, a word or two.', { maxLength: 60 }),
        schema: string(`The schema to tag in (default "${AGENT_SCHEMA}").`),
      },
      required: ['entry_ids', 'tag'],
    },
    readOnly: false,
    run: (ctx, a) => {
      const ids = a.entry_ids;
      if (!Array.isArray(ids) || !ids.every((v) => Number.isInteger(v) && v > 0)) throw new UsageError('entry_ids must be a list of entry ids.');
      const result = tagAsAgent(ctx.store, ctx.agent, { entryIds: ids as number[], tag: text(a, 'tag', 60, true), schema: text(a, 'schema', 100) }, ctx.now());
      return {
        schema: result.schema,
        tag: result.tag,
        run_id: result.runId,
        tagged: result.tagged.length,
        already_tagged: result.already.length,
        ...(result.runId === null ? { message: 'Every entry already had this tag, so no run was made.' } : {}),
      };
    },
  },
  {
    name: 'not_mine',
    title: 'Mark a thread not mine',
    description:
      "Mark a whole thread as someone else's words, so search, questions and the organiser leave it out. Use it only when the user says a conversation isn't theirs; they can bring it back.",
    inputSchema: { type: 'object', properties: { thread_id: integer('The thread.') }, required: ['thread_id'] },
    readOnly: false,
    run: (ctx, a) => {
      const threadId = id(a, 'thread_id');
      const thread = ctx.store.visibleThread(threadId);
      if (!thread) throw new UsageError(`There is no thread ${threadId} in the record.`);
      ctx.store.setNotMine(threadId, true);
      return { thread_id: threadId, not_mine: true, message: `"${thread.title}" is left out now. The user can bring it back with: skeinwise not-mine ${threadId} --undo` };
    },
  },
  {
    name: 'undo_run',
    title: 'Undo a run',
    description: 'Take back a run you made (tag_entries gives its run_id): everything it added is removed. You can undo only your own runs.',
    inputSchema: { type: 'object', properties: { run_id: integer('The run.') }, required: ['run_id'] },
    readOnly: false,
    run: (ctx, a) => {
      const runId = id(a, 'run_id');
      const run = getRun(ctx.store.db, runId);
      if (!run) throw new UsageError(`There is no run ${runId}.`);
      if (run.engine !== AGENT_ENGINE || run.model?.toLowerCase() !== ctx.agent.toLowerCase()) {
        throw new UsageError(`Run ${runId} wasn't made by ${ctx.agent}, so ${ctx.agent} can't undo it.`);
      }
      const result = undoRun(ctx.store.db, runId);
      return { run_id: runId, status: result.run.status, removed: result.removed };
    },
  },
];
