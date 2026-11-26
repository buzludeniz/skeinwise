// Tags an agent gives entries. Each call is one run under the agent's name (engine 'agent', the name as the model), so
// it shows in "skeinwise runs" and "undo" takes it back like any run. An agent's run stays live until it is undone:
// the organiser's own tag runs neither replace it nor are replaced by it (migration 3's live_runs).

import { UsageError } from '../errors.ts';
import { currentMark, finishRun, type RunEngine, startRun } from '../organiser/runs.ts';
import { findSchema, liveTags, type Schema, schemas } from '../organiser/views.ts';
import { inTransaction } from '../store/db.ts';
import type { Store } from '../store/store.ts';

/** The schema an agent's tags go in unless it names another one. */
export const AGENT_SCHEMA = 'Agent tags';
/** The runs table's engine for an agent's run. */
export const AGENT_ENGINE: RunEngine = 'agent';

/** Most entries one call may tag. */
export const MAX_TAGGED = 500;

export interface AgentTagging {
  schema: string;
  tag: string;
  /** The run that holds the new tags, or null when every entry already had the tag. */
  runId: number | null;
  tagged: number[];
  already: number[];
}

export function tagAsAgent(store: Store, agent: string, input: { entryIds: number[]; tag: string; schema?: string }, now: string): AgentTagging {
  const name = input.tag.trim().replace(/\s+/g, ' ');
  if (!name) throw new UsageError('Give the tag to add, for example "garden".');
  if (name.length > 60) throw new UsageError('Keep a tag name under 60 characters.');
  const ids = [...new Set(input.entryIds)];
  if (!ids.length) throw new UsageError('Give at least one entry id to tag.');
  if (ids.length > MAX_TAGGED) throw new UsageError(`Tag at most ${MAX_TAGGED} entries in one call.`);
  for (const id of ids) {
    if (!store.visibleEntry(id)) throw new UsageError(`There is no entry ${id} in the record. Nothing was tagged.`);
  }
  const db = store.db;
  return inTransaction(db, () => {
    const schema = pickSchema(store, input.schema?.trim() || AGENT_SCHEMA);
    const live = liveTags(db, schema.id).find((t) => t.name.toLowerCase() === name.toLowerCase());
    const already = ids.filter((id) => live?.entryIds.includes(id));
    const fresh = ids.filter((id) => !already.includes(id));
    const tag = live?.name ?? name;
    if (!fresh.length) return { schema: schema.name, tag, runId: null, tagged: [], already };
    const runId = startRun(db, { task: 'tag', engine: AGENT_ENGINE, model: agent, scope: 'agent', schemaId: schema.id, mark: currentMark(db), now });
    const defined = db.prepare('SELECT id FROM tags WHERE schema_id = ? AND run_id IS NULL AND name = ? COLLATE NOCASE').get(schema.id, name) as
      | { id: number }
      | undefined;
    const tagId =
      defined?.id ??
      Number(db.prepare("INSERT INTO tags (schema_id, name, description, run_id) VALUES (?, ?, '', ?)").run(schema.id, tag, runId).lastInsertRowid);
    const insert = db.prepare('INSERT INTO entry_tags (entry_id, tag_id, run_id, score) VALUES (?, ?, ?, 1)');
    for (const id of fresh) insert.run(id, tagId, runId);
    finishRun(db, runId, {
      counts: { entries: fresh.length, tagged: fresh.length, tags: 1, added: fresh.length, unchanged: already.length },
      message: `${agent} tagged ${fresh.length} ${fresh.length === 1 ? 'entry' : 'entries'} "${tag}".`,
      tokensIn: 0,
      tokensOut: 0,
      now,
    });
    return { schema: schema.name, tag, runId, tagged: fresh, already };
  });
}

function pickSchema(store: Store, name: string): Schema {
  const found = findSchema(store.db, name);
  if (found) {
    if (found.builtin && (found.name === 'Topics' || found.name === 'Projects')) {
      throw new UsageError(`The organiser makes ${found.name} from your entries, so agents can't add to it. Use "${AGENT_SCHEMA}", Moods or a schema of your own.`);
    }
    return found;
  }
  if (name.toLowerCase() !== AGENT_SCHEMA.toLowerCase()) {
    const names = schemas(store.db).map((s) => s.name);
    throw new UsageError(`There is no schema "${name}". Leave the schema out to use "${AGENT_SCHEMA}", or pick one of: ${names.join(', ')}.`);
  }
  const description = "Tags agents gave entries through Skeinwise's memory server.";
  const res = store.db.prepare('INSERT INTO schemas (name, description, builtin) VALUES (?, ?, 0)').run(AGENT_SCHEMA, description);
  return { id: Number(res.lastInsertRowid), name: AGENT_SCHEMA, description, builtin: false };
}
