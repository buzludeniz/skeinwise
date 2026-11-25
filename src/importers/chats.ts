import type { EntryInput, ImportBatch, ThreadInput } from '../store/store.ts';
import { hashText } from '../store/store.ts';
import { asArray, blockText, firstLine, isObj, type Obj, parseJsonl, str, stripHtml, toIso } from './util.ts';

const FALLBACK_DATE = '1970-01-01T00:00:00.000Z';

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

export function parseChatGPT(data: unknown): ImportBatch {
  const threads: ThreadInput[] = [];
  for (const conv of asArray(data).filter(isObj)) {
    const convDate = toIso(conv.create_time) ?? FALLBACK_DATE;
    const convId = str(conv.conversation_id) ?? str(conv.id) ?? hashText(`${str(conv.title)}|${convDate}`).slice(0, 16);
    const entries: EntryInput[] = [];
    for (const node of chatgptBranch(conv)) {
      const m = node.message;
      if (!isObj(m)) continue;
      const role = isObj(m.author) ? str(m.author.role) : undefined;
      if (role !== 'user' && role !== 'assistant') continue;
      const meta = isObj(m.metadata) ? m.metadata : {};
      if (meta.is_visually_hidden_from_conversation) continue;
      entries.push({
        externalId: `${convId}:${str(m.id) ?? str(node.id) ?? entries.length}`,
        kind: 'message',
        speaker: role === 'user' ? 'you' : 'assistant',
        createdAt: toIso(m.create_time) ?? convDate,
        body: chatgptText(m),
      });
    }
    const title = str(conv.title) || firstLine(entries.find((e) => e.speaker === 'you')?.body ?? '') || 'Untitled chat';
    threads.push({ externalId: convId, title, startedAt: convDate, entries });
  }
  return { source: { kind: 'chatgpt', label: 'ChatGPT' }, threads };
}

// ---------- Claude (conversations.json from the account data export) ----------

export function parseClaude(data: unknown): ImportBatch {
  const threads: ThreadInput[] = [];
  for (const conv of asArray(data).filter(isObj)) {
    const convDate = toIso(conv.created_at) ?? FALLBACK_DATE;
    const convId = str(conv.uuid) ?? hashText(`${str(conv.name)}|${convDate}`).slice(0, 16);
    const entries: EntryInput[] = asArray(conv.chat_messages)
      .filter(isObj)
      .map((m, i) => ({
        externalId: str(m.uuid) ?? `${convId}:${i}`,
        kind: 'message' as const,
        speaker: m.sender === 'human' ? 'you' : 'assistant',
        createdAt: toIso(m.created_at) ?? convDate,
        body: str(m.text) || blockText(m.content),
      }));
    const title = str(conv.name) || firstLine(entries.find((e) => e.speaker === 'you')?.body ?? '') || 'Untitled chat';
    threads.push({ externalId: convId, title, startedAt: convDate, entries });
  }
  return { source: { kind: 'claude', label: 'Claude' }, threads };
}

// ---------- Gemini (Google Takeout: My Activity / Gemini Apps / MyActivity.json) ----------

const GEMINI_GAP_MS = 30 * 60 * 1000;

export function parseGemini(data: unknown): ImportBatch {
  const items = asArray(data)
    .filter(isObj)
    .filter((it) => {
      const products = asArray(it.products).map(String);
      return /gemini|bard/i.test(str(it.header) ?? '') || products.some((p) => /gemini|bard/i.test(p));
    })
    .map((it) => {
      const title = str(it.title) ?? '';
      const prompt = title.replace(/^(Prompted|Asked)\s+/i, '');
      const html = asArray(it.safeHtmlItem)
        .filter(isObj)
        .map((h) => str(h.html) ?? '')
        .join('\n');
      return { time: toIso(it.time), prompt, reply: stripHtml(html) };
    })
    .filter((it): it is { time: string; prompt: string; reply: string } => Boolean(it.time && it.prompt))
    .sort((a, b) => a.time.localeCompare(b.time));

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

export function parseClaudeCodeSession(text: string, fallbackId: string): ThreadInput {
  const lines = parseJsonl(text);
  let summary: string | undefined;
  let sessionId: string | undefined;
  const entries: EntryInput[] = [];
  for (const line of lines) {
    if (line.type === 'summary') summary ??= str(line.summary);
    if (line.type !== 'user' && line.type !== 'assistant') continue;
    if (line.isSidechain || line.isMeta) continue;
    sessionId ??= str(line.sessionId);
    const message = isObj(line.message) ? line.message : {};
    const body = blockText(message.content);
    if (!body.trim() || AGENT_NOISE.test(body)) continue;
    entries.push({
      externalId: str(line.uuid) ?? `${fallbackId}:${entries.length}`,
      kind: 'message',
      speaker: line.type === 'user' ? 'you' : 'assistant',
      createdAt: toIso(line.timestamp) ?? FALLBACK_DATE,
      body,
    });
  }
  const title = summary || firstLine(entries.find((e) => e.speaker === 'you')?.body ?? '') || 'Coding session';
  return { externalId: sessionId ?? fallbackId, title, entries };
}

// ---------- Codex CLI (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) ----------

export function parseCodexSession(text: string, fallbackId: string): ThreadInput {
  const lines = parseJsonl(text);
  let sessionId: string | undefined;
  const entries: EntryInput[] = [];
  lines.forEach((line, n) => {
    const payload = isObj(line.payload) ? line.payload : {};
    if (line.type === 'session_meta') {
      sessionId ??= str(payload.id);
      return;
    }
    if (line.type !== 'response_item' || payload.type !== 'message') return;
    const role = str(payload.role);
    if (role !== 'user' && role !== 'assistant') return;
    const body = blockText(payload.content, ['input_text', 'output_text', 'text']);
    if (!body.trim() || AGENT_NOISE.test(body) || body.startsWith('# AGENTS.md')) return;
    entries.push({
      externalId: `${sessionId ?? fallbackId}:${n}`,
      kind: 'message',
      speaker: role === 'user' ? 'you' : 'assistant',
      createdAt: toIso(line.timestamp) ?? FALLBACK_DATE,
      body,
    });
  });
  const title = firstLine(entries.find((e) => e.speaker === 'you')?.body ?? '') || 'Coding session';
  return { externalId: sessionId ?? fallbackId, title, entries };
}
