// LS-05 (M7, L3): one bad value skips or flags that entry alone, named by file and place, and the rest imports.
// Built from PoC 01 (01_malformed.mjs: a nanosecond timestamp, an impossible date in a note's name, a broken
// numeric entity, an unreadable file) and PoC 15 (15_fallback_ids.mjs: two id-less chats with the same title).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaude, parseClaudeCodeSession, parseCodexSession, parseGemini } from '../src/importers/chats.ts';
import { readImports } from '../src/importers/detect.ts';
import { entity, FileReport, stripHtml, toIso } from '../src/importers/util.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-malformed-'));
});
afterAll(() => {
  const locked = join(dir, '01d_unreadable', 'locked.md');
  if (existsSync(locked)) chmodSync(locked, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

function imported(path: string): { batches: ReturnType<typeof readImports>; warnings: string[] } {
  const warnings: string[] = [];
  const batches = readImports(path, { onWarning: (m) => warnings.push(m) });
  return { batches, warnings };
}

const store = () => new Store(openDb(':memory:'));

// PoC 01's ChatGPT conversation, as it builds it.
const good = (id: string, text: string) => ({
  id,
  conversation_id: id,
  title: `good ${id}`,
  create_time: 1700000000,
  current_node: 'm1',
  mapping: { m1: { id: 'm1', parent: null, message: { id: 'm1', author: { role: 'user' }, create_time: 1700000000, content: { parts: [text] } } } },
});

describe('PoC 01: one malformed value never stops an import', () => {
  it('a) a nanosecond timestamp keeps its message, with its conversation’s time, and names where it was', () => {
    const bad = good('c-bad', 'bad one');
    bad.mapping.m1.message.create_time = 1.7e18;
    mkdirSync(join(dir, '01a_chatgpt_ns'));
    const file = join(dir, '01a_chatgpt_ns', 'conversations.json');
    writeFileSync(file, JSON.stringify([good('c-1', 'first good'), good('c-2', 'second good'), bad]));

    const { batches, warnings } = imported(file);
    const entries = batches[0]!.threads.flatMap((t) => t.entries);
    expect(entries.map((e) => [e.body, e.createdAt])).toEqual([
      ['first good', '2023-11-14T22:13:20.000Z'],
      ['second good', '2023-11-14T22:13:20.000Z'],
      ['bad one', '2023-11-14T22:13:20.000Z'],
    ]);
    expect(warnings).toEqual([
      'conversations.json:3 (message 1): 1700000000000000000 is not a time; kept the entry with its conversation’s time',
    ]);
    expect(store().ingest(batches[0]!)).toMatchObject({ added: 3, threads: 3 });
  });

  it('b) a note named with an impossible date is dated by the file and named, and the other 50 import too', () => {
    const vault = join(dir, '01b_vault');
    mkdirSync(vault);
    for (let i = 0; i < 50; i++) writeFileSync(join(vault, `note-${i}.md`), `# Note ${i}\n\nbody ${i}`);
    writeFileSync(join(vault, 'Meeting 2023-14-02.md'), '# Meeting\n\ntypo in the month');

    const { batches, warnings } = imported(vault);
    expect(warnings).toEqual(['Meeting 2023-14-02.md: "2023-14-02" is not a time; kept the entry with the file’s time']);
    const notes = batches[0]!.entries!;
    expect(notes).toHaveLength(51);
    const meeting = notes.find((e) => e.title === 'Meeting')!;
    expect(meeting.createdAt).toBe(statSync(join(vault, 'Meeting 2023-14-02.md')).mtime.toISOString());
    expect(store().ingest(batches[0]!)).toMatchObject({ added: 51 });
  });

  it('c) a broken numeric entity stays as written and is named by its item, and both Gemini replies import', () => {
    mkdirSync(join(dir, '01c_gemini'));
    const item = (t: string, prompt: string, html: string) => ({
      header: 'Gemini Apps',
      title: `Prompted ${prompt}`,
      time: t,
      products: ['Gemini Apps'],
      safeHtmlItem: [{ html }],
    });
    const file = join(dir, '01c_gemini', 'MyActivity.json');
    writeFileSync(
      file,
      JSON.stringify([
        item('2025-01-01T10:00:00.000Z', 'good prompt', '<p>fine &amp; dandy</p>'),
        item('2025-01-02T10:00:00.000Z', 'bad prompt', '<p>see &#x; or &#99999999;</p>'),
      ]),
    );
    const { batches, warnings } = imported(file);
    expect(warnings).toEqual(['MyActivity.json:2: "&#x;" and 1 more name no character; kept as written']);
    expect(batches[0]!.threads.flatMap((t) => t.entries.map((e) => e.body))).toEqual([
      'good prompt',
      'fine & dandy',
      'bad prompt',
      'see &#x; or &#99999999;',
    ]);
  });

  // chmod can't make a file unreadable on Windows (it only sets the read-only bit), so this runs on macOS and Linux.
  it.skipIf(process.platform === 'win32')('d) an unreadable file is named and skipped; the three beside it import', () => {
    const folder = join(dir, '01d_unreadable');
    mkdirSync(folder);
    for (let i = 0; i < 3; i++) writeFileSync(join(folder, `ok-${i}.md`), `# ok ${i}`);
    writeFileSync(join(folder, 'locked.md'), '# locked', { mode: 0o000 });

    const { batches, warnings } = imported(folder);
    expect(batches[0]!.entries!.map((e) => e.title).sort()).toEqual(['ok 0', 'ok 1', 'ok 2']);
    expect(warnings).toEqual([expect.stringMatching(/locked\.md: skipped, EACCES/)]);
  });

  it('a front matter date that is no date is named with its line, and the note keeps the next date it has', () => {
    const vault = join(dir, 'front-matter-dates');
    mkdirSync(vault);
    const write = (name: string, text: string) => writeFileSync(join(vault, name), text);
    write('typo.md', '---\ntitle: Typo\ncreated: 2023-14-02\n---\n# Typo\n');
    write('2024-03-01 standup.md', '---\nDate: "next tuesday"\n---\nstandup notes\n');
    write('fine.md', '---\ncreated: 2024-05-06\ndate: not read, created is\n---\nfine\n');
    write('2024-07-08 plain.md', 'no front matter\n');
    write('Q 2024-99-99.md', '---\ndate: 2024-09-10\n---\nthe front matter dates it\n');

    const { batches, warnings } = imported(vault);
    expect(warnings.sort()).toEqual([
      '2024-03-01 standup.md:2: "next tuesday" is not a time; kept the entry with the date in its name',
      'typo.md:3: "2023-14-02" is not a time; kept the entry with the file’s time',
    ]);
    const created = Object.fromEntries(batches[0]!.entries!.map((e) => [e.title, e.createdAt]));
    expect(created).toMatchObject({
      Typo: statSync(join(vault, 'typo.md')).mtime.toISOString(),
      '2024-03-01 standup': '2024-03-01T09:00:00.000Z',
      fine: '2024-05-06T00:00:00.000Z',
      '2024-07-08 plain': '2024-07-08T09:00:00.000Z',
      'Q 2024-99-99': '2024-09-10T00:00:00.000Z',
    });
  });

  it('names one Gemini item once, however many references in it name no character, and counts past 20', () => {
    const many = Array.from({ length: 23 }, (_, n) => ({
      header: 'Gemini Apps',
      title: `Prompted q${n}`,
      time: `2025-01-01T10:${String(n).padStart(2, '0')}:00.000Z`,
      products: ['Gemini Apps'],
      safeHtmlItem: [{ html: '<p>&#xD800; &#0; &#x110000; &copy; &#65;</p>' }],
    }));
    const warnings: string[] = [];
    const report = new FileReport('MyActivity.json', (m) => warnings.push(m));
    const batch = parseGemini(many, report);
    report.done();
    expect(batch.threads.flatMap((t) => t.entries.map((e) => e.body))).toContain('&#xD800; &#0; &#x110000; &copy; A');
    expect(warnings).toHaveLength(21);
    expect(warnings[0]).toBe('MyActivity.json:1: "&#xD800;" and 2 more name no character; kept as written');
    expect(warnings[20]).toBe('MyActivity.json: 3 more like that (0 skipped, 0 kept without their time, 23 kept as written)');
  });

  it('an entry that throws is skipped and named; the rest of its conversation and the export import', () => {
    const warnings: string[] = [];
    const report = new FileReport('conversations.json', (m) => warnings.push(m));
    const conversation = {
      uuid: 'k1',
      name: 'Bread',
      chat_messages: [
        {
          uuid: 'm1',
          get text(): string {
            throw new Error('a value no parser expects');
          },
        },
        { uuid: 'm2', sender: 'human', text: 'Why is my crumb tight?' },
      ],
    };
    const batch = parseClaude([{ uuid: 'k0', name: 'Fine', chat_messages: [{ uuid: 'm0', sender: 'human', text: 'hello' }] }, conversation], report);
    expect(batch.threads.map((t) => t.entries.map((e) => e.body))).toEqual([['hello'], ['Why is my crumb tight?']]);
    expect(warnings).toEqual(['skipped 1 entry in conversations.json:2 (message 1): a value no parser expects']);
    expect(report).toMatchObject({ skipped: 1, untimed: 0 });
  });

  it('a session line with a bad time keeps its entry with no time, named by line; past 20 it only counts', () => {
    const lines = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({ type: 'user', sessionId: 's1', uuid: `u${i}`, timestamp: i === 0 ? '2025-04-01T09:00:00Z' : 'not a time', message: { role: 'user', content: `line ${i}` } }),
    );
    const warnings: string[] = [];
    const report = new FileReport('projects/s1.jsonl', (m) => warnings.push(m));
    const thread = parseClaudeCodeSession(['{"type":"summary","summary":"Times"}', ...lines].join('\n'), 's1', report);
    expect(thread.entries).toHaveLength(25);
    expect(thread.entries[0]!.createdAt).toBe('2025-04-01T09:00:00.000Z');
    expect(thread.entries[1]!.createdAt).toBe('');
    report.done();
    expect(warnings[0]).toBe('projects/s1.jsonl:3: "not a time" is not a time; kept the entry with no time');
    expect(warnings).toHaveLength(21);
    expect(warnings[20]).toBe('projects/s1.jsonl: 4 more like that (0 skipped, 24 kept without their time)');

    const codex = parseCodexSession(
      JSON.stringify({ type: 'response_item', timestamp: 1.7e18, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }),
      'rollout-1',
    );
    expect(codex.entries.map((e) => [e.body, e.createdAt])).toEqual([['hi', '']]);
  });

  it('a conversations.json that is not JSON is named; other JSON files that aren’t are left alone', () => {
    const folder = join(dir, 'broken-json');
    mkdirSync(folder);
    writeFileSync(join(folder, 'conversations.json'), '[{"uuid": "k1", "chat_messages": [');
    writeFileSync(join(folder, 'settings.json'), '{ not json');
    writeFileSync(join(folder, 'idea.md'), '# Idea');
    const { batches, warnings } = imported(folder);
    expect(batches.map((b) => b.source.kind)).toEqual(['notes']);
    expect(warnings).toEqual([expect.stringMatching(/^skipped 1 file in conversations\.json: it is not valid JSON/)]);
  });

  it('quotes values from the file safely in what it prints', () => {
    const warnings: string[] = [];
    const report = new FileReport(`evil${String.fromCharCode(27)}[2J.jsonl`, (m) => warnings.push(m));
    report.time('1', `x${String.fromCharCode(27)}]0;title${String.fromCharCode(7)}`, '');
    expect(warnings[0]).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('PoC 15: conversations without ids stay apart', () => {
  it('two untitled, undated chats are two threads with no invented time, and "tax" is found', () => {
    const folder = join(dir, '15');
    mkdirSync(folder);
    const conv = (text: string) => ({ name: 'New chat', chat_messages: [{ sender: 'human', text }] });
    writeFileSync(join(folder, 'conversations.json'), JSON.stringify([conv('Conversation A: my tax notes'), conv('Conversation B: groceries')]));

    const { batches } = imported(join(folder, 'conversations.json'));
    const threads = batches[0]!.threads;
    expect(threads).toHaveLength(2);
    expect(threads[0]!.externalId).not.toBe(threads[1]!.externalId);
    expect(threads.flatMap((t) => t.entries.map((e) => e.createdAt))).toEqual(['', '']);

    const s = store();
    expect(s.ingest(batches[0]!)).toMatchObject({ added: 2, versioned: 0, threads: 2 });
    expect(s.search('tax').map((e) => e.body)).toEqual(['Conversation A: my tax notes']);
    expect(s.db.prepare('SELECT time_flag AS flag, claimed_at AS claimed FROM entries ORDER BY id').all()).toEqual([
      { flag: 'missing', claimed: null },
      { flag: 'missing', claimed: null },
    ]);
    // The same export again changes nothing: the ids are stable.
    expect(s.ingest(imported(join(folder, 'conversations.json')).batches[0]!)).toMatchObject({ added: 0, unchanged: 2 });
  });
});

describe('toIso and entities never throw', () => {
  it('turns what isn’t a time into nothing', () => {
    expect(toIso(1.7e18)).toBeUndefined();
    expect(toIso(Number.NaN)).toBeUndefined();
    expect(toIso(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(toIso('2023-14-02T09:00:00Z')).toBeUndefined();
    expect(toIso(-1)).toBe('1969-12-31T23:59:59.000Z');
    expect(toIso(8.64e15)).toBe('+275760-09-13T00:00:00.000Z');
  });

  it('keeps an entity that stands for no character as written', () => {
    expect(['#x', '#99999999', '#xD800', '#0', '#x110000', '#x1F600', '#65', 'amp', 'nope'].map(entity)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '😀',
      'A',
      '&',
      undefined,
    ]);
    expect(stripHtml('<p>see &#x; or &#99999999; &#xD800; &#0; &#x1F600;</p>')).toBe('see &#x; or &#99999999; &#xD800; &#0; 😀');
    const unread: string[] = [];
    expect(stripHtml('<p>&#x; &copy; &nope; &#99999999; &amp; &#65;</p>', (r) => unread.push(r))).toBe('&#x; &copy; &nope; &#99999999; & A');
    expect(unread).toEqual(['&#x;', '&#99999999;']);
  });
});
