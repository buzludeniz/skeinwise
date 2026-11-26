import type { EntryInput, ImportBatch, ThreadInput } from '../store/store.ts';
import { hashText } from '../store/store.ts';
import { asArray, blockText, claimedTime, FileReport, firstLine, isObj, type Obj, parseJsonlLines, str, stripHtml } from './util.ts';

/**
 * The time an entry claims. One the export gives but can't be read is reported, and the entry keeps `fallback` (its
 * conversation's time) or none: '' means none, and the store then sorts it by when it was first seen.
 */
function timeOf(value: unknown, fallback: string, at: string, report: FileReport): string {
  const iso = claimedTime(value);
  if (iso === undefined) report.time(at, value, fallback ? 'its conversation’s time' : '');
  return iso || fallback;
}

/** A conversation's time: '' when it has none or one that can't be read (its entries say which). */
function conversationTime(value: unknown): string {
  return claimedTime(value) ?? '';
}

/**
 * The id for a conversation the export gave none: the file, its place in it and what it says. Title and time alone
 * collide: two untitled chats with no time became one, the second's messages saved as new versions of the first's.
 */
function fallbackId(report: FileReport, n: number, title: string, time: string, first: string): string {
  return hashText(`${report.file}\n${n}\n${title}\n${time}\n${first}`).slice(0, 16);
}

// ---------- ChatGPT (conversations.json from the account data export) ----------

function chatgptText(message: Obj): string {
  const content = isObj(message.content) ? message.content : {};
  const parts = asArray(content.parts)
    .map((p) => (typeof p === 'string' ? p : isObj(p) && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean);
  if (parts.length) return parts.join('\n\n');
  return str(content.text) ?? '';
}

/** Follows the active branch: from current_node up through parents. Falls back to all nodes by time. */
function chatgptBranch(conv: Obj): Obj[] {
  const mapping = isObj(conv.mapping) ? conv.mapping : {};
  const chain: Obj[] = [];
  const seen = new Set<string>();
  let id = str(conv.current_node);
  while (id && !seen.has(id) && isObj(mapping[id])) {
    seen.add(id);
    const node = mapping[id] as Obj;
    chain.push(node);
    id = str(node.parent);
  }
  if (chain.length) return chain.reverse();
  return Object.values(mapping)
    .filter(isObj)
    .sort((a, b) => {
      const ta = isObj(a.message) ? Number(a.message.create_time ?? 0) : 0;
      const tb = isObj(b.message) ? Number(b.message.create_time ?? 0) : 0;
      return ta - tb;
    });
}

/**
 * Each conversation, and each message in it, is parsed on its own: a bad one is skipped and named in `report` with its
 * place (conversation n, message m, from 1), and the rest of the export goes on.
 */
export function parseChatGPT(data: unknown, report = new FileReport('conversations.json')): ImportBatch {
  const threads: ThreadInput[] = [];
  asArray(data).forEach((conv, n) => {
    if (!isObj(conv)) return;
    const thread = report.each(`${n + 1}`, () => chatgptThread(conv, n, report), 'conversation');
    if (thread) threads.push(thread);
  });
  return { source: { kind: 'chatgpt', label: 'ChatGPT' }, threads };
}

function chatgptThread(conv: Obj, n: number, report: FileReport): ThreadInput {
  const convDate = conversationTime(conv.create_time);
  const nodes = chatgptBranch(conv).filter((node) => {
    const m = node.message;
    if (!isObj(m)) return false;
    const role = isObj(m.author) ? str(m.author.role) : undefined;
    const meta = isObj(m.metadata) ? m.metadata : {};
    return (role === 'user' || role === 'assistant') && !meta.is_visually_hidden_from_conversation;
  });
  const first = nodes.map((node) => node.message as Obj).find((m) => isObj(m.author) && m.author.role === 'user');
  const convId =
    str(conv.conversation_id) ?? str(conv.id) ?? fallbackId(report, n, str(conv.title) ?? '', convDate, first ? chatgptText(first) : '');
  const entries: EntryInput[] = [];
  nodes.forEach((node, i) => {
    const at = `${n + 1} (message ${i + 1})`;
    const entry = report.each(at, () => {
      const m = node.message as Obj;
      const role = (m.author as Obj).role;
      return {
        externalId: `${convId}:${str(m.id) ?? str(node.id) ?? entries.length}`,
        kind: 'message' as const,
        speaker: role === 'user' ? 'you' : 'assistant',
        createdAt: timeOf(m.create_time, convDate, at, report),
        body: chatgptText(m),
      };
    });
    if (entry) entries.push(entry);
  });
  const title = str(conv.title) || firstLine(entries.find((e) => e.speaker === 'you')?.body ?? '') || 'Untitled chat';
  return { externalId: convId, title, startedAt: convDate, entries };
}

// ---------- Claude (conversations.json from the account data export) ----------

/** As parseChatGPT: each conversation and message on its own, a bad one skipped and named. */
export function parseClaude(data: unknown, report = new FileReport('conversations.json')): ImportBatch {
  const threads: ThreadInput[] = [];
  asArray(data).forEach((conv, n) => {
    if (!isObj(conv)) return;
    const thread = report.each(`${n + 1}`, () => claudeThread(conv, n, report), 'conversation');
    if (thread) threads.push(thread);
  });
  return { source: { kind: 'claude', label: 'Claude' }, threads };
}

function claudeText(m: Obj): string {
  return str(m.text) || blockText(m.content);
}

function claudeThread(conv: Obj, n: number, report: FileReport): ThreadInput {
  const convDate = conversationTime(conv.created_at);
  const messages = asArray(conv.chat_messages).filter(isObj);
  const first = messages.find((m) => m.sender === 'human');
  const convId = str(conv.uuid) ?? fallbackId(report, n, str(conv.name) ?? '', convDate, first ? claudeText(first) : '');
  const entries: EntryInput[] = [];
  messages.forEach((m, i) => {
    const at = `${n + 1} (message ${i + 1})`;
    const entry = report.each(at, () => ({
      externalId: str(m.uuid) ?? `${convId}:${i}`,
      kind: 'message' as const,
      speaker: m.sender === 'human' ? 'you' : 'assistant',
      createdAt: timeOf(m.created_at, convDate, at, report),
      body: claudeText(m),
    }));
    if (entry) entries.push(entry);
  });
  const title = str(conv.name) || firstLine(entries.find((e) => e.speaker === 'you')?.body ?? '') || 'Untitled chat';
  return { externalId: convId, title, startedAt: convDate, entries };
}

// ---------- Gemini (Google Takeout: My Activity / Gemini Apps / MyActivity.json) ----------

const GEMINI_GAP_MS = 30 * 60 * 1000;

/**
 * Activity items are grouped into conversations by time, so an item whose time can't be read can't be placed: it is
 * skipped and named (item n, from 1), as is one that fails to parse.
 */
export function parseGemini(data: unknown, report = new FileReport('MyActivity.json')): ImportBatch {
  const items: { time: string; prompt: string; reply: string }[] = [];
  asArray(data).forEach((it, n) => {
    if (!isObj(it)) return;
    const products = asArray(it.products).map(String);
    if (!/gemini|bard/i.test(str(it.header) ?? '') && !products.some((p) => /gemini|bard/i.test(p))) return;
    const item = report.each(`${n + 1}`, () => {
      const prompt = (str(it.title) ?? '').replace(/^(Prompted|Asked)\s+/i, '');
      if (!prompt) return undefined;
      const time = claimedTime(it.time);
      if (!time) throw new Error(time === '' ? 'it has no time' : `${JSON.stringify(it.time)} is not a time`);
      const html = asArray(it.safeHtmlItem)
        .filter(isObj)
        .map((h) => str(h.html) ?? '')
        .join('\n');
      return { time, prompt, reply: stripHtml(html) };
    });
    if (item) items.push(item);
  });
  items.sort((a, b) => a.time.localeCompare(b.time));

  const threads: ThreadInput[] = [];
  let current: ThreadInput | undefined;
  let lastMs = 0;
  for (const it of items) {
    const ms = Date.parse(it.time);
    if (!current || ms - lastMs > GEMINI_GAP_MS) {
      current = { externalId: it.time, title: firstLine(it.prompt), startedAt: it.time, entries: [] };
      threads.push(current);
    }
    lastMs = ms;
    current.entries.push({ externalId: `${it.time}:p`, kind: 'message', speaker: 'you', createdAt: it.time, body: it.prompt });
    if (it.reply) {
      current.entries.push({ externalId: `${it.time}:r`, kind: 'message', speaker: 'assistant', createdAt: it.time, body: it.reply });
    }
  }
  return { source: { kind: 'gemini', label: 'Gemini' }, threads };
}

// ---------- Claude Code (~/.claude/projects/<slug>/<session>.jsonl) ----------

/** Wrapper text the CLI injects (commands, reminders, tool output): not something the person wrote. */
const AGENT_NOISE = /^\s*<(command-|local-command|system-reminder|user-prompt-submit-hook|bash-|environment_context|user_instructions)/;

/** Spans a CLI or a hook adds inside a message, cut out wherever they stand. */
const INJECTED = [
  ['<system-reminder>', '</system-reminder>'],
  ['<user-prompt-submit-hook>', '</user-prompt-submit-hook>'],
] as const;

/** How Claude Code opens the summary it writes when it compacts a session (older lines carry no isCompactSummary). */
const COMPACT_SUMMARY = 'This session is being continued from a previous conversation that ran out of context.';

/** Cuts each injected span out of the text in one pass. An opening tag with no closing one is left as written. */
function cutInjected(text: string): string {
  let out = text;
  for (const [open, close] of INJECTED) {
    if (!out.includes(open)) continue;
    let kept = '';
    let from = 0;
    for (let start = out.indexOf(open); start >= 0; start = out.indexOf(open, from)) {
      const end = out.indexOf(close, start + open.length);
      if (end < 0) break;
      kept += out.slice(from, start);
      from = end + close.length;
    }
    if (from) out = (kept + out.slice(from)).trim();
  }
  return out;
}

/**
 * What a person or an assistant wrote in an agent session: each text block with its injected spans cut out, and a
 * block that is only wrapper text dropped, so a reminder sent ahead of a prompt no longer hides the prompt, and one
 * sent after it is no longer saved as the person's words. Text with nothing injected comes back exactly as written.
 */
export function agentText(content: unknown, types: readonly string[] = ['text']): string {
  const blocks =
    typeof content === 'string'
      ? [content]
      : asArray(content)
          .filter((b): b is Obj => isObj(b) && types.includes(String(b.type)))
          .map((b) => str(b.text) ?? '');
  return blocks
    .map(cutInjected)
    .filter((t) => t.trim() && !AGENT_NOISE.test(t))
    .join('\n\n');
}

/** A user line that carries a tool's output: Claude Code files tool results as the user's turn. */
function isToolResult(line: Obj, message: Obj): boolean {
  return line.toolUseResult !== undefined || asArray(message.content).some((b) => isObj(b) && b.type === 'tool_result');
}

/** The working folder and git branch an agent session line was run in, when it names them. */
function context(project: unknown, gitBranch: unknown): Pick<EntryInput, 'project' | 'gitBranch'> {
  const cwd = str(project)?.trim();
  const branch = str(gitBranch)?.trim();
  return { ...(cwd ? { project: cwd } : {}), ...(branch ? { gitBranch: branch } : {}) };
}

/** Each line is parsed on its own: a bad one is skipped and named by its line number. */
export function parseClaudeCodeSession(text: string, fallbackId: string, report = new FileReport(`${fallbackId}.jsonl`)): ThreadInput {
  let summary: string | undefined;
  let sessionId: string | undefined;
  const entries: EntryInput[] = [];
  for (const { line: n, value: line } of parseJsonlLines(text)) {
    if (line.type === 'summary') summary ??= str(line.summary);
    if (line.type !== 'user' && line.type !== 'assistant') continue;
    // Side chains are subagents' talk, meta lines the CLI's own notes, and a compaction summary restates the session
    // in the model's words: none of them is the person's.
    if (line.isSidechain || line.isMeta || line.isCompactSummary) continue;
    sessionId ??= str(line.sessionId);
    const entry = report.each(`${n}`, () => {
      const message = isObj(line.message) ? line.message : {};
      if (line.type === 'user' && isToolResult(line, message)) return undefined;
      const body = agentText(message.content);
      if (!body.trim() || body.startsWith(COMPACT_SUMMARY)) return undefined;
      return {
        externalId: str(line.uuid) ?? `${fallbackId}:${entries.length}`,
        kind: 'message' as const,
        speaker: line.type === 'user' ? 'you' : 'assistant',
        createdAt: timeOf(line.timestamp, '', `${n}`, report),
        body,
        ...context(line.cwd, line.gitBranch),
      };
    });
    if (entry) entries.push(entry);
  }
  const title = summary || firstLine(entries.find((e) => e.speaker === 'you')?.body ?? '') || 'Coding session';
  return { externalId: sessionId ?? fallbackId, title, entries };
}

// ---------- Codex CLI (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) ----------

/** As parseClaudeCodeSession: a bad line is skipped and named by its line number. */
export function parseCodexSession(text: string, fallbackId: string, report = new FileReport(`${fallbackId}.jsonl`)): ThreadInput {
  let sessionId: string | undefined;
  // The session's folder and branch from session_meta; a turn_context line moves the folder when the session does.
  let cwd: string | undefined;
  let branch: string | undefined;
  const entries: EntryInput[] = [];
  // n, the object's place among the parsed lines, is part of each entry's id: keep it, so ids stay as they were.
  parseJsonlLines(text).forEach(({ line: lineNo, value: line }, n) => {
    const payload = isObj(line.payload) ? line.payload : {};
    if (line.type === 'session_meta') {
      sessionId ??= str(payload.id);
      cwd ??= str(payload.cwd);
      branch ??= isObj(payload.git) ? str(payload.git.branch) : undefined;
      return;
    }
    if (line.type === 'turn_context') {
      cwd = str(payload.cwd) ?? cwd;
      return;
    }
    if (line.type !== 'response_item' || payload.type !== 'message') return;
    const role = str(payload.role);
    if (role !== 'user' && role !== 'assistant') return;
    const entry = report.each(`${lineNo}`, () => {
      const body = agentText(payload.content, ['input_text', 'output_text', 'text']);
      if (!body.trim() || body.startsWith('# AGENTS.md')) return undefined;
      return {
        externalId: `${sessionId ?? fallbackId}:${n}`,
        kind: 'message' as const,
        speaker: role === 'user' ? 'you' : 'assistant',
        createdAt: timeOf(line.timestamp, '', `${lineNo}`, report),
        body,
        ...context(cwd, branch),
      };
    });
    if (entry) entries.push(entry);
  });
  const title = firstLine(entries.find((e) => e.speaker === 'you')?.body ?? '') || 'Coding session';
  return { externalId: sessionId ?? fallbackId, title, entries };
}
