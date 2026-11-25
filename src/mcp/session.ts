// One agent's session with the memory server: the stdio server runs once per agent connection, so this holds what that
// connection may do and how much it has read. Each call checks the lock and the token again (agents.json is read every
// time), then the scope: a read-scope token lists and runs only the read tools. What a tool returns goes out framed as
// untrusted data, redacted and cut to fit (frame.ts), and the session stops at MAX_SESSION_BYTES. Every call, served or
// refused, goes in the MCP log (log.ts).

import type { Store } from '../store/store.ts';
import { AccessError, checkAccess, quoteArg, type Session } from './access.ts';
import { FitError, frame, MAX_CALL_BYTES, MAX_SESSION_BYTES } from './frame.ts';
import { type LogRecord, logArgs, logCall } from './log.ts';
import type { Tool } from './protocol.ts';
import { type MemoryCtx, MEMORY_TOOLS } from './tools.ts';

/** What the protocol knows about the caller: only the name its client gives, which proves nothing. */
export interface Caller {
  label: string | null;
}

export interface SessionOptions {
  store: Store;
  home: string;
  /** The token from the agent's MCP config (SKEINWISE_AGENT_TOKEN), if it gave one. */
  token: string | undefined;
  now: () => string;
}

/** The tools whose entries are hubs, so the log names them as hubs. */
const HUB_TOOLS = new Set(['list_hubs', 'read_hub']);

const FULL =
  'This session has had 500 KB of the record, the most one session gets, so Skeinwise refuses more. Start a new session to read on.';

export class MemorySession {
  readonly tools: Tool<Caller>[];
  /** Bytes of results this session has sent. */
  served = 0;
  private readonly o: SessionOptions;

  constructor(options: SessionOptions, tools: Tool<MemoryCtx>[] = MEMORY_TOOLS) {
    this.o = options;
    this.tools = tools.map((tool) => ({ ...tool, run: (caller: Caller, args: Record<string, unknown>) => this.run(tool, caller, args) }));
  }

  /** The tools this session's token may call. Without a valid token, the read tools, whose calls then say what is missing. */
  listed(): Tool<Caller>[] {
    let scope: Session['scope'] | null = null;
    try {
      scope = checkAccess(this.o.home, this.o.token).scope;
    } catch {
      // locked, no token, or a broken agents.json: the read tools are listed and each call explains
    }
    return this.tools.filter((t) => t.readOnly || scope === 'write');
  }

  private async run(tool: Tool<MemoryCtx>, caller: Caller, args: Record<string, unknown>): Promise<string> {
    const record: LogRecord = { at: this.o.now(), agent: null, label: caller.label, tool: tool.name, args: logArgs(args), bytes: 0, truncated: false, outcome: 'ok' };
    let text: string;
    try {
      text = await this.serve(tool, caller, args, record);
    } catch (err) {
      record.outcome = err instanceof AccessError ? 'refused' : 'error';
      record.reason = (err as Error).message.slice(0, 500);
      logCall(this.o.home, record);
      throw err;
    }
    logCall(this.o.home, record);
    return text;
  }

  private async serve(tool: Tool<MemoryCtx>, caller: Caller, args: Record<string, unknown>, record: LogRecord): Promise<string> {
    const { home, store, token, now } = this.o;
    const who = checkAccess(home, token, caller.label);
    record.agent = who.agent;
    if (!tool.readOnly && who.scope !== 'write') {
      throw new AccessError(
        `not allowed: read scope. ${who.agent} may only read the record, and ${tool.name} changes it. To let it write, run: skeinwise mcp allow ${quoteArg(who.agent)} --write`,
      );
    }
    const room = Math.min(MAX_CALL_BYTES, MAX_SESSION_BYTES - this.served);
    if (room <= 0) throw new AccessError(FULL);
    const value = (await tool.run({ store, home, agent: who.agent, now }, args)) as Record<string, unknown>;
    const { entries, ...fields } = value;
    try {
      const framed = frame(tool.name, fields, Array.isArray(entries) ? entries : [], room);
      this.served += framed.bytes;
      const ids = framed.entries.map((e) => (e as { id?: unknown }).id).filter((v): v is number => typeof v === 'number');
      if (typeof fields.entry_id === 'number') ids.push(fields.entry_id);
      if (Array.isArray(args.entry_ids) && !tool.readOnly) ids.push(...args.entry_ids.filter((v): v is number => Number.isInteger(v)).slice(0, 100));
      if (ids.length) record[HUB_TOOLS.has(tool.name) ? 'hub_ids' : 'entry_ids'] = ids;
      record.bytes = framed.bytes;
      record.truncated = framed.truncated;
      return framed.text;
    } catch (err) {
      if (err instanceof FitError) throw new AccessError(FULL);
      throw err;
    }
  }
}
