import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, strToU8, zipSync } from 'fflate';
import { buildZip } from './fsafe-zip.ts';
import { parseChatGPT, parseClaude, parseClaudeCodeSession, parseCodexSession, parseGemini } from '../src/importers/chats.ts';
import { accountFingerprint, readFilesUnder, readImports, readImportsInWorker, sniffExport, sniffSession } from '../src/importers/detect.ts';
import { UnsafeFileError } from '../src/fsafe.ts';
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
    expect(parseFrontMatter('no front matter')).toEqual({ meta: {}, properties: {}, body: 'no front matter' });
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

  // Windows has no FIFOs (mkfifo there makes nothing Node can see), so this runs on macOS and Linux.
  it.skipIf(process.platform === 'win32')('skips links, FIFOs and unreadable files in a folder by name, and imports the rest (PoC 12, 13)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-unsafe-'));
    const outside = mkdtempSync(join(tmpdir(), 'skeinwise-outside-'));
    try {
      writeFileSync(join(outside, 'secret.md'), 'FAKE-SECRET');
      symlinkSync(join(outside, 'secret.md'), join(dir, 'planted.md'));
      symlinkSync(outside, join(dir, 'linked-folder'));
      execFileSync('mkfifo', [join(dir, 'conversations.json')]);
      writeFileSync(join(dir, 'claude.json'), JSON.stringify(claude));
      writeFileSync(join(dir, 'note.md'), '# Mine');
      const warnings: string[] = [];
      const started = performance.now();
      const batches = readImports(dir, { onWarning: (m) => warnings.push(m) });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(batches.map((b) => b.source.kind).sort()).toEqual(['claude', 'notes']);
      expect(JSON.stringify(batches)).not.toContain('FAKE-SECRET');
      expect(warnings).toEqual([
        expect.stringMatching(/conversations\.json: skipped, it is not a regular file/),
        expect.stringMatching(/planted\.md: skipped, it is a symbolic link/),
      ]);
      // The live path reads named files the same way: the link is refused, the FIFO doesn't block.
      const live: string[] = [];
      const some = readFilesUnder(dir, ['planted.md', 'conversations.json', 'linked-folder/secret.md', 'note.md'], { onWarning: (m) => live.push(m) });
      expect(JSON.stringify(some)).not.toContain('FAKE-SECRET');
      expect(some.flatMap((b) => b.entries ?? []).map((e) => e.externalId)).toEqual(['note.md']);
      expect(live).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a zip bomb by name before inflating it (PoC 09), in a worker too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-bomb-'));
    try {
      // Two entries that say they unpack to 64 MiB each from a few bytes: far past the 200:1 limit. Built by hand, so
      // the test doesn't spend seconds deflating 128 MiB on a loaded machine.
      const kernel = deflateSync(new Uint8Array(4096).fill(32));
      const bomb = join(dir, '09_bomb.zip');
      const size = 64 * 1024 * 1024;
      writeFileSync(bomb, buildZip([{ name: 'export/part-0.json', data: kernel, size }, { name: 'export/part-1.json', data: kernel, size }]));
      expect(() => readImports(bomb)).toThrow(/09_bomb\.zip: refused, .*200:1 limit/);
      const error = await readImportsInWorker(bomb).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnsafeFileError);
      expect((error as UnsafeFileError).reason).toBe('zip');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a dropped zip that would unpack to 900 MiB before inflating it (PoC web/08), and blocks no caller (PoC 18b)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-drop-'));
    try {
      // web/08's shape: three zip64 entries of 300 MiB each. Each is under the 1 GiB file limit and all three under the
      // 4 GiB total, so only the 200:1 ratio refuses it. Built by hand from a small kernel, as in the test above.
      const kernel = deflateSync(new Uint8Array(4096));
      const size = 300 * 1024 * 1024;
      const drop = join(dir, 'export.zip');
      const names = ['conversations.json', 'b.json', 'c.json'];
      writeFileSync(drop, buildZip(names.map((name) => ({ name, data: kernel, size })), { zip64: true }));
      const rss = process.memoryUsage().rss;
      const started = performance.now();
      expect(() => readImports(drop)).toThrow(/export\.zip: refused, .*\(900 MiB\), past the 200:1 limit/);
      // 18b: upload/finish once read on the server's own thread, so /api/status waited out the inflation. The refusal
      // comes from the zip's directory, so even a caller on the main thread is held for that read alone.
      expect(performance.now() - started).toBeLessThan(100);
      expect(process.memoryUsage().rss - rss).toBeLessThan(300 * 1024 * 1024);
      let ticks = 0;
      const timer = setInterval(() => ticks++, 1);
      try {
        const error = await readImportsInWorker(drop).catch((e: unknown) => e);
        expect((error as UnsafeFileError).reason).toBe('zip');
        expect((error as Error).message).toMatch(/past the 200:1 limit/);
      } finally {
        clearInterval(timer);
      }
      expect(ticks).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads in a worker thread with the same batches and warnings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-worker-'));
    try {
      writeFileSync(join(dir, 'export.zip'), zipSync({ 'conversations.json': strToU8(JSON.stringify(claude)) }));
      expect(await readImportsInWorker(join(dir, 'export.zip'))).toEqual(readImports(join(dir, 'export.zip')));
      symlinkSync(join(dir, 'export.zip'), join(dir, 'link.md'));
      writeFileSync(join(dir, 'note.md'), 'mine');
      const warnings: string[] = [];
      const batches = await readImportsInWorker(dir, { owner: 'Mara', onWarning: (m) => warnings.push(m) });
      expect(batches.map((b) => [b.source.kind, b.source.owner])).toEqual([['notes', 'Mara']]);
      expect(warnings).toEqual([expect.stringContaining('link.md: skipped, it is a symbolic link')]);
      await expect(readImportsInWorker(join(dir, 'missing'))).rejects.toThrow(/ENOENT/);
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

describe('origin and account on every batch (LS-02)', () => {
  const sha = (bytes: Buffer | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const claudeExport = (accountUuid?: string) =>
    JSON.stringify([
      {
        uuid: 'k1',
        name: 'Crumb',
        created_at: '2025-02-01T08:00:00Z',
        ...(accountUuid ? { account: { uuid: accountUuid } } : {}),
        chat_messages: [{ uuid: 'm1', sender: 'human', text: 'Why is my crumb tight?', created_at: '2025-02-01T08:00:00Z' }],
      },
    ]);
  const chatgptExport = JSON.stringify([
    { title: 'Plans', create_time: 1735725600, conversation_id: 'c1', current_node: 'u1', mapping: { u1: chatgptNode('u1', null, 'user', 'Seeds?', 1735725601) } },
  ]);
  const session = (id: string) =>
    [
      JSON.stringify({ type: 'user', sessionId: id, uuid: `${id}-1`, timestamp: '2025-03-01T10:00:00Z', cwd: '/w', message: { role: 'user', content: 'hello' } }),
    ].join('\n');

  function within(fn: (dir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'skeinwise-origin-'));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a single export file is the origin; its account is a fingerprint, never the raw id', () => {
    within((dir) => {
      const file = join(dir, 'conversations.json');
      writeFileSync(file, claudeExport('acct-uuid-invented-1'));
      const [batch] = readImports(file);
      expect(batch!.origin).toEqual({ path: file, sha256: sha(readFileSync(file)) });
      expect(batch!.account).toBe(accountFingerprint('claude', 'acct-uuid-invented-1'));
      expect(batch!.account).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(batch)).not.toContain('acct-uuid-invented-1');
      writeFileSync(file, claudeExport());
      expect(readImports(file)[0]!.account).toBeNull();
    });
  });

  it('a zip is the origin of every batch in it, and user.json names the ChatGPT account', () => {
    within((dir) => {
      const file = join(dir, 'export.zip');
      writeFileSync(
        file,
        zipSync({
          'conversations.json': strToU8(chatgptExport),
          'user.json': strToU8(JSON.stringify({ id: 'user-invented-7', email: 'someone@example.invalid' })),
          'notes/a.md': strToU8('# A\nnote'),
        }),
      );
      const batches = readImports(file);
      const origin = { path: file, sha256: sha(readFileSync(file)) };
      expect(batches.map((b) => [b.source.kind, b.origin, b.account ?? null])).toEqual([
        ['chatgpt', origin, accountFingerprint('chatgpt', 'user-invented-7')],
        ['notes', origin, null],
      ]);
      expect(batches[1]!.entries![0]!.origin).toBeUndefined();
    });
  });

  it('in a folder, each export, session and note carries its own file; Claude’s users.json names the account', () => {
    within((dir) => {
      mkdirSync(join(dir, 'claude'));
      mkdirSync(join(dir, 'projects'));
      writeFileSync(join(dir, 'claude', 'conversations.json'), claudeExport());
      writeFileSync(join(dir, 'claude', 'users.json'), JSON.stringify([{ uuid: 'acct-uuid-invented-2', full_name: 'X' }]));
      writeFileSync(join(dir, 'projects', 's1.jsonl'), session('s1'));
      writeFileSync(join(dir, 'idea.md'), '# Idea\nkeep it');
      const batches = readImports(dir);
      const own = (p: string) => ({ path: join(dir, p), sha256: sha(readFileSync(join(dir, p))) });
      const byKind = Object.fromEntries(batches.map((b) => [b.source.kind, b]));
      expect(byKind.claude!.origin).toEqual(own('claude/conversations.json'));
      expect(byKind.claude!.account).toBe(accountFingerprint('claude', 'acct-uuid-invented-2'));
      expect(byKind['claude-code']!.origin).toBeNull();
      expect(byKind['claude-code']!.threads[0]!.origin).toEqual(own('projects/s1.jsonl'));
      expect(byKind.notes!.origin).toBeNull();
      expect(byKind.notes!.entries![0]!.origin).toEqual(own('idea.md'));
      // readFilesUnder (live) gives the same per-file origins.
      const [notes] = readFilesUnder(dir, ['idea.md']);
      expect(notes!.entries![0]!.origin).toEqual(own('idea.md'));
    });
  });
});
