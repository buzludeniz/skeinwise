// One agent's session with the memory server: the stdio server runs once per agent connection, so this holds what that
// connection may do and how much it has read. Each call checks the lock and the token again (agents.json is read every
// time), then the scope: a read-scope token lists and runs only the read tools. What a tool returns goes out framed as
// untrusted data, redacted and cut to fit (frame.ts), and the session stops at MAX_SESSION_BYTES.

import type { Store } from '../store/store.ts';
import { AccessError, checkAccess, quoteArg, type Session } from './access.ts';
import { FitError, frame, MAX_CALL_BYTES, MAX_SESSION_BYTES } from './frame.ts';
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
    const { home, store, token, now } = this.o;
    const who = checkAccess(home, token, caller.label);
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
      return framed.text;
    } catch (err) {
      if (err instanceof FitError) throw new AccessError(FULL);
      throw err;
    }
  }
}
