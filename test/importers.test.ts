import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { parseChatGPT, parseClaude, parseClaudeCodeSession, parseCodexSession, parseGemini } from '../src/importers/chats.ts';
import { readImports, sniffExport, sniffSession } from '../src/importers/detect.ts';
import { parseFrontMatter, parseNote } from '../src/importers/notes.ts';
import { toIso } from '../src/importers/util.ts';

function chatgptNode(id: string, parent: string | null, role: string | null, text: string, t: number, extra: object = {}) {
  return {
    id,
    parent,
    children: [],
    message: role
      ? { id, author: { role }, create_time: t, content: { content_type: 'text', parts: [text] }, metadata: extra }
      : null,
  };
}

describe('parseChatGPT', () => {
  const conv = {
    title: 'Allotment plans',
    create_time: 1735725600,
    conversation_id: 'c1',
    current_node: 'a2',
    mapping: {
      root: chatgptNode('root', null, null, '', 0),
      sys: chatgptNode('sys', 'root', 'system', 'You are helpful', 1735725600),
      u1: chatgptNode('u1', 'sys', 'user', 'First question', 1735725601),
      a1: chatgptNode('a1', 'u1', 'assistant', 'An answer I regenerated', 1735725602),
      a2: chatgptNode('a2', 'u1', 'assistant', 'The answer I kept', 1735725603),
      hidden: chatgptNode('hidden', 'a2', 'user', 'context', 1735725604, { is_visually_hidden_from_conversation: true }),
    },
  };

  it('follows the active branch and keeps only your and the assistant’s messages', () => {
    const batch = parseChatGPT([conv]);
    expect(batch.source).toEqual({ kind: 'chatgpt', label: 'ChatGPT' });
    const [thread] = batch.threads;
    expect(thread!.title).toBe('Allotment plans');
    expect(thread!.entries.map((e) => [e.speaker, e.body])).toEqual([
      ['you', 'First question'],
      ['assistant', 'The answer I kept'],
    ]);
    expect(thread!.entries[0]!.externalId).toBe('c1:u1');
    expect(thread!.entries[0]!.createdAt).toBe('2025-01-01T10:00:01.000Z');
  });

  it('skips hidden messages and survives junk', () => {
    const withHidden = { ...conv, current_node: 'hidden' };
    expect(parseChatGPT([withHidden]).threads[0]!.entries).toHaveLength(2);
    expect(parseChatGPT({ not: 'a list' }).threads).toEqual([]);
    expect(parseChatGPT([null, 3, { mapping: 'x' }]).threads[0]!.entries).toEqual([]);
  });
});

describe('parseClaude', () => {
  it('maps human to you and falls back to content blocks', () => {
    const batch = parseClaude([
      {
        uuid: 'k1',
        name: '',
        created_at: '2025-02-01T08:00:00Z',
        chat_messages: [
          { uuid: 'm1', sender: 'human', text: 'Why is my crumb tight?', created_at: '2025-02-01T08:00:00Z' },
          { uuid: 'm2', sender: 'assistant', text: '', content: [{ type: 'text', text: 'Under-fermented.' }] },
        ],
      },
    ]);
    const thread = batch.threads[0]!;
    expect(thread.title).toBe('Why is my crumb tight?');
    expect(thread.entries.map((e) => e.speaker)).toEqual(['you', 'assistant']);
    expect(thread.entries[1]!.body).toBe('Under-fermented.');
    expect(thread.entries[1]!.createdAt).toBe('2025-02-01T08:00:00.000Z');
  });
});

describe('parseGemini', () => {
  const item = (time: string, title: string, html?: string) => ({
    header: 'Gemini Apps',
    title,
    time,
    products: ['Gemini Apps'],
    ...(html ? { safeHtmlItem: [{ html }] } : {}),
  });

  it('groups prompts into threads by 30-minute gaps and strips HTML', () => {
    const batch = parseGemini([
      item('2025-03-01T10:20:00Z', 'Prompted second', '<p>Two &amp; three</p>'),
      item('2025-03-01T10:00:00Z', 'Prompted first', '<p>One</p>'),
      item('2025-03-01T11:00:00Z', 'Prompted later'),
      { header: 'Search', title: 'Searched for bread', time: '2025-03-01T10:05:00Z' },
    ]);
    expect(batch.threads.map((t) => t.entries.map((e) => e.body))).toEqual([['first', 'One', 'second', 'Two & three'], ['later']]);
  });
});

describe('Claude Code and Codex sessions', () => {
  it('reads a Claude Code session, dropping side chains, meta lines and injected text', () => {
    const lines = [
      { type: 'summary', summary: 'Fix double bookings' },
      { type: 'user', sessionId: 's1', uuid: 'u1', timestamp: '2025-04-01T09:00:00Z', message: { role: 'user', content: 'Reminders go out twice' } },
      { type: 'user', sessionId: 's1', uuid: 'u2', isMeta: true, message: { role: 'user', content: 'meta' } },
      { type: 'user', sessionId: 's1', uuid: 'u3', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'assistant', sessionId: 's1', uuid: 'a1', isSidechain: true, message: { content: [{ type: 'text', text: 'side' }] } },
      {
        type: 'assistant',
        sessionId: 's1',
        uuid: 'a2',
        timestamp: '2025-04-01T09:01:00Z',
        message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'Take a lock first.' }] },
      },
      '{"torn line',
    ];
    const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
    expect(sniffSession(text)).toBe('claude-code');
    const thread = parseClaudeCodeSession(text, 'fallback');
    expect(thread.externalId).toBe('s1');
    expect(thread.title).toBe('Fix double bookings');
    expect(thread.entries.map((e) => e.body)).toEqual(['Reminders go out twice', 'Take a lock first.']);
  });

  it('reads a Codex session and skips the injected AGENTS.md', () => {
    const lines = [
      { type: 'session_meta', timestamp: '2025-05-01T10:00:00Z', payload: { id: 'x9' } },
      { type: 'response_item', timestamp: '2025-05-01T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] } },
      { type: 'response_item', timestamp: '2025-05-01T10:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Parse the sensor CSV' }] } },
      { type: 'response_item', timestamp: '2025-05-01T10:00:03Z', payload: { type: 'reasoning', content: [] } },
      { type: 'response_item', timestamp: '2025-05-01T10:00:04Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Use the csv crate.' }] } },
    ];
    const text = lines.map((l) => JSON.stringify(l)).join('\n');
    expect(sniffSession(text)).toBe('codex');
    const thread = parseCodexSession(text, 'fallback');
    expect(thread.externalId).toBe('x9');
    expect(thread.title).toBe('Parse the sensor CSV');
    expect(thread.entries.map((e) => [e.speaker, e.body])).toEqual([
      ['you', 'Parse the sensor CSV'],
      ['assistant', 'Use the csv crate.'],
    ]);
  });
});

describe('notes', () => {
  const mtime = new Date('2026-01-05T12:00:00Z');

  it('reads front matter, headings, tags and links', () => {
    const note = parseNote(
      'plotline.md',
      '---\ntitle: "Plotline"\ncreated: 2025-02-03\ntags: [Project, plotline]\naliases:\n  - booking app\n---\n# Heading\n\nSee [[Waiting list|the list]] and [[Committee#May]]. #allotment, not a#tag.\n',
      mtime,
    );
    expect(note.title).toBe('Plotline');
    expect(note.createdAt).toBe('2025-02-03T00:00:00.000Z');
    expect(note.tags.sort()).toEqual(['allotment', 'plotline', 'project']);
    expect(note.links).toEqual(['Waiting list', 'Committee']);
    expect(note.meta.aliases).toEqual(['booking app']);
    expect(note.body.startsWith('# Heading')).toBe(true);
  });

  it('takes the date from the file name, then the modified time', () => {
    expect(parseNote('2025-07-14.md', 'Rode 60 km.', mtime).createdAt).toBe('2025-07-14T09:00:00.000Z');
    const plain = parseNote('ideas.txt', 'just text', mtime);
    expect(plain.createdAt).toBe(mtime.toISOString());
    expect(plain.title).toBe('ideas');
  });

  it('leaves text without front matter alone', () => {
    expect(parseFrontMatter('no front matter')).toEqual({ meta: {}, body: 'no front matter' });
  });
});

describe('toIso', () => {
  it('accepts seconds, milliseconds and strings', () => {
    expect(toIso(1735725600)).toBe('2025-01-01T10:00:00.000Z');
    expect(toIso(1735725600000)).toBe('2025-01-01T10:00:00.000Z');
    expect(toIso('2025-01-01T10:00:00Z')).toBe('2025-01-01T10:00:00.000Z');
    expect(toIso('not a date')).toBeUndefined();
    expect(toIso(null)).toBeUndefined();
  });
});

describe('readImports', () => {
  const chatgpt = [{ title: 't', create_time: 1735725600, conversation_id: 'c', current_node: 'u', mapping: { u: chatgptNode('u', null, 'user', 'hello', 1735725600) } }];
  const claude = [{ uuid: 'k', name: 'n', created_at: '2025-01-01T00:00:00Z', chat_messages: [{ uuid: 'm', sender: 'human', text: 'hi' }] }];
  const session = JSON.stringify({ type: 'user', sessionId: 's', uuid: 'u', timestamp: '2025-01-01T00:00:00Z', message: { content: 'hey' } });

  it('finds every kind of source in a folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-imp-'));
    try {
      mkdirSync(join(dir, 'export'), { recursive: true });
      mkdirSync(join(dir, 'projects', 'p'), { recursive: true });
      mkdirSync(join(dir, '.obsidian'), { recursive: true });
      writeFileSync(join(dir, 'export', 'conversations.json'), JSON.stringify(chatgpt));
      writeFileSync(join(dir, 'claude.json'), JSON.stringify(claude));
      writeFileSync(join(dir, 'projects', 'p', 's.jsonl'), session);
      writeFileSync(join(dir, 'note.md'), '# A note');
      writeFileSync(join(dir, '.obsidian', 'workspace.md'), 'ignored');
      writeFileSync(join(dir, 'broken.json'), '{');
      const batches = readImports(dir);
      expect(batches.map((b) => b.source.kind).sort()).toEqual(['chatgpt', 'claude', 'claude-code', 'notes']);
      const notes = batches.find((b) => b.source.kind === 'notes')!;
      expect(notes.entries!.map((e) => e.externalId)).toEqual(['note.md']);
      expect(readImports(dir, { owner: 'Mara' }).find((b) => b.source.kind === 'notes')!.source.owner).toBe('Mara');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a zip and a single file, and refuses an empty folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-zip-'));
    try {
      const zip = zipSync({ 'conversations.json': strToU8(JSON.stringify(claude)), '__MACOSX/._x.json': strToU8('{}'), 'img.png': new Uint8Array([1]) });
      writeFileSync(join(dir, 'export.zip'), zip);
      expect(readImports(join(dir, 'export.zip')).map((b) => b.source.kind)).toEqual(['claude']);
      writeFileSync(join(dir, 'one.json'), JSON.stringify(chatgpt));
      expect(readImports(join(dir, 'one.json')).map((b) => b.source.kind)).toEqual(['chatgpt']);
      mkdirSync(join(dir, 'empty'));
      expect(() => readImports(join(dir, 'empty'))).toThrow(/Nothing to import/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recognises export shapes', () => {
    expect(sniffExport([{ mapping: {} }])).toBe('chatgpt');
    expect(sniffExport([{ chat_messages: [] }])).toBe('claude');
    expect(sniffExport([{ time: 'x', title: 'y' }])).toBe('gemini');
    expect(sniffExport({})).toBeNull();
  });
});
