// LS-18: agent histories keep their context. Claude Code and Codex entries keep the folder (project) and git branch
// they were run in; compaction summaries, injected reminders and tool results are no longer saved as "you"; and
// search takes a project. The sessions are invented and built here.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { agentText, parseClaudeCodeSession, parseCodexSession } from '../src/importers/chats.ts';
import { readImports } from '../src/importers/detect.ts';
import { STORE_FLAGS, STORE_SEARCH_HELP } from '../src/store/commands.ts';
import { openDb } from '../src/store/db.ts';
import { Store } from '../src/store/store.ts';

const jsonl = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const REMINDER = '<system-reminder>\nThe date is 2026-04-01. Files you read may be stale.\n</system-reminder>';

/** A Claude Code session run in `cwd`, with every kind of line that isn't the person's words. */
function claudeCodeSession(id: string, cwd: string, branch: string, prompt: string): string {
  const at = (m: number) => `2026-04-01T09:${String(m).padStart(2, '0')}:00.000Z`;
  const base = { sessionId: id, cwd, gitBranch: branch, version: '2.1.0', userType: 'external' };
  return jsonl([
    { type: 'summary', summary: `Work on ${cwd.split('/').at(-1)}` },
    { ...base, type: 'user', uuid: `${id}-u1`, timestamp: at(0), message: { role: 'user', content: prompt } },
    {
      ...base,
      type: 'assistant',
      uuid: `${id}-a1`,
      timestamp: at(1),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the scheduler first.' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
    },
    // The tool's output comes back as the user's turn, with a reminder beside it.
    {
      ...base,
      type: 'user',
      uuid: `${id}-u2`,
      timestamp: at(2),
      toolUseResult: { stdout: 'export function schedule() {}' },
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'export function schedule() {}' },
          { type: 'text', text: REMINDER },
        ],
      },
    },
    // A tool result without the toolUseResult field, as older versions wrote it.
    {
      ...base,
      type: 'user',
      uuid: `${id}-u3`,
      timestamp: at(3),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'TOOL OUTPUT: 3 files changed' }] }] },
    },
    // The person's next prompt, with a reminder sent ahead of it and a hook's note after it.
    {
      ...base,
      type: 'user',
      uuid: `${id}-u4`,
      timestamp: at(4),
      message: {
        role: 'user',
        content: [
          { type: 'text', text: REMINDER },
          { type: 'text', text: 'Keep the lock, but time it out after a minute.' },
          { type: 'text', text: `Also check the retries.\n\n${REMINDER}` },
        ],
      },
    },
    // After /compact: the summary is flagged...
    {
      ...base,
      type: 'user',
      uuid: `${id}-u5`,
      timestamp: at(5),
      isCompactSummary: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. SUMMARY: the user wants locks.' },
    },
    // ...and an older version wrote the same summary without the flag.
    {
      ...base,
      type: 'user',
      uuid: `${id}-u6`,
      timestamp: at(6),
      message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. SUMMARY: the user wants locks.' },
    },
    { ...base, type: 'assistant', uuid: `${id}-a2`, timestamp: at(7), message: { role: 'assistant', content: [{ type: 'text', text: 'The lock now times out after 60 s.' }] } },
  ]);
}

describe('Claude Code sessions', () => {
  const text = claudeCodeSession('s-plot', '/home/mara/code/plotline', 'fix/double-booking', 'Reminders go out twice in plotline');
  const thread = parseClaudeCodeSession(text, 'fallback');

  it('save only what the person and the assistant wrote, each under the right name', () => {
    expect(thread.entries.map((e) => [e.speaker, e.body])).toEqual([
      ['you', 'Reminders go out twice in plotline'],
      ['assistant', 'Reading the scheduler first.'],
      ['you', 'Keep the lock, but time it out after a minute.\n\nAlso check the retries.'],
      ['assistant', 'The lock now times out after 60 s.'],
    ]);
    const yours = thread.entries.filter((e) => e.speaker === 'you').map((e) => e.body).join('\n');
    for (const injected of ['system-reminder', 'TOOL OUTPUT', 'export function schedule', 'SUMMARY', 'continued from a previous conversation']) {
      expect(yours).not.toContain(injected);
    }
  });

  it('keep the folder and branch of every entry', () => {
    expect(thread.entries.map((e) => [e.project, e.gitBranch])).toEqual(
      Array(4).fill(['/home/mara/code/plotline', 'fix/double-booking']),
    );
  });

  it('keep a line without a folder or branch as it was', () => {
    const bare = parseClaudeCodeSession(jsonl([{ type: 'user', sessionId: 's', uuid: 'u', message: { role: 'user', content: 'hi' } }]), 'f');
    expect(bare.entries[0]).toEqual({ externalId: 'u', kind: 'message', speaker: 'you', createdAt: '', body: 'hi' });
  });
});

describe('Codex sessions', () => {
  const lines = [
    {
      type: 'session_meta',
      timestamp: '2026-04-02T10:00:00Z',
      payload: { id: 'x-ledger', cwd: '/home/mara/code/ledger', git: { commit_hash: 'abc123', branch: 'main', repository_url: 'git@example.invalid:mara/ledger.git' } },
    },
    { type: 'response_item', timestamp: '2026-04-02T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/home/mara/code/ledger</cwd>\n</environment_context>' }] } },
    { type: 'response_item', timestamp: '2026-04-02T10:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Round the totals to cents' }] } },
    { type: 'response_item', timestamp: '2026-04-02T10:00:03Z', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' } },
    { type: 'response_item', timestamp: '2026-04-02T10:00:04Z', payload: { type: 'function_call_output', call_id: 'c1', output: 'TOOL OUTPUT: ledger.rs' } },
    { type: 'compacted', timestamp: '2026-04-02T10:00:05Z', payload: { message: 'SUMMARY: the user wants cents.' } },
    { type: 'turn_context', timestamp: '2026-04-02T10:00:06Z', payload: { cwd: '/home/mara/code/ledger/cli', model: 'local' } },
    { type: 'response_item', timestamp: '2026-04-02T10:00:07Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Same for the CLI' }] } },
    { type: 'response_item', timestamp: '2026-04-02T10:00:08Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done: both round half to even.' }] } },
  ];
  const thread = parseCodexSession(jsonl(lines), 'fallback');

  it('save only the messages, with the folder each turn ran in and the session’s branch', () => {
    expect(thread.entries.map((e) => [e.speaker, e.body, e.project, e.gitBranch])).toEqual([
      ['you', 'Round the totals to cents', '/home/mara/code/ledger', 'main'],
      ['you', 'Same for the CLI', '/home/mara/code/ledger/cli', 'main'],
      ['assistant', 'Done: both round half to even.', '/home/mara/code/ledger/cli', 'main'],
    ]);
  });

  it('keep the entry ids they had before', () => {
    expect(thread.entries.map((e) => e.externalId)).toEqual(['x-ledger:2', 'x-ledger:7', 'x-ledger:8']);
  });
});

describe('agentText', () => {
  it('gives text with nothing injected back exactly as written', () => {
    const written = '  Indented first line\n\n\ttabbed, and a trailing space ';
    expect(agentText(written)).toBe(written);
    expect(agentText([{ type: 'text', text: written }])).toBe(written);
  });

  it('cuts every reminder, and leaves an opening tag with no closing one as written', () => {
    expect(agentText(`a ${REMINDER} b ${REMINDER} c`)).toBe('a  b  c');
    expect(agentText('Why does <system-reminder> show up in my logs?')).toBe('Why does <system-reminder> show up in my logs?');
    expect(agentText('<user-prompt-submit-hook>lint passed</user-prompt-submit-hook>Ship it')).toBe('Ship it');
    expect(agentText(REMINDER)).toBe('');
  });

  it('runs in one pass on 200,000 hostile characters', () => {
    for (const hostile of ['<system-reminder>'.repeat(12_500), '<system-reminder></system-reminder>x'.repeat(5_700)]) {
      const started = performance.now();
      agentText(hostile);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});

describe('search --project (acceptance)', () => {
  let dir: string;
  let store: Store;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-agents-'));
    const projects = join(dir, 'claude-code', 'projects');
    const sessions: [string, string, string][] = [
      ['s-plot', '/home/mara/code/plotline', 'Reminders go out twice in plotline'],
      ['s-plot-web', '/home/mara/code/plotline/web', 'The plotline page shows reminders twice'],
      ['s-plotter', '/home/mara/code/plotter', 'Reminders in plotter are fine'],
      ['s-ledger', '/home/mara/code/ledger', 'Reminders for invoices go out twice'],
    ];
    for (const [id, cwd, prompt] of sessions) {
      const folder = join(projects, cwd.replaceAll('/', '-'));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${id}.jsonl`), claudeCodeSession(id, cwd, 'main', prompt));
    }
    store = new Store(openDb(':memory:'));
    for (const batch of readImports(join(dir, 'claude-code'))) store.ingest(batch);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const projectsOf = (hits: { id: number }[]) => [...new Set(hits.map((h) => store.getEntry(h.id)!.project))].sort();

  it('a folder name returns only that project, its subfolders included', () => {
    const hits = store.search('reminders', { project: 'plotline' });
    expect(hits.length).toBeGreaterThan(0);
    expect(projectsOf(hits)).toEqual(['/home/mara/code/plotline', '/home/mara/code/plotline/web']);
    expect(projectsOf(store.search('reminders'))).toHaveLength(4);
  });

  it('matches whole folder names, and a full path from its start', () => {
    expect(store.search('reminders', { project: 'plot' })).toEqual([]);
    expect(store.search('reminders', { project: 'plot%' })).toEqual([]);
    expect(projectsOf(store.search('reminders', { project: 'code/plotline/' }))).toEqual(['/home/mara/code/plotline', '/home/mara/code/plotline/web']);
    expect(projectsOf(store.search('reminders', { project: '/home/mara/code/plotline/web' }))).toEqual(['/home/mara/code/plotline/web']);
    expect(store.search('reminders', { project: '/mara/code/plotline' })).toEqual([]);
    expect(() => store.search('reminders', { project: ' / ' })).toThrow('Give a project');
  });

  it('no "you" result holds a summary, a reminder or a tool’s output', () => {
    // Words only the reminder ("stale"), the summary ("continued") and the tools' output ("export", "changed") hold.
    for (const word of ['stale', 'continued', 'export', 'changed']) {
      expect(store.search(word, { speaker: 'you', strict: true, limit: 100 }), word).toEqual([]);
    }
    expect(store.search('continued', { strict: true })).toEqual([]);
  });

  it('an entry imported before LS-18 gains its folder and branch on the next import, with no new version', () => {
    const old = new Store(openDb(':memory:'));
    const session = claudeCodeSession('s-old', '/home/mara/code/plotline', 'main', 'An old prompt');
    const strip = (t: string) => t.replace(/"(cwd|gitBranch)":"[^"]*",?/g, '');
    old.ingest({ source: { kind: 'claude-code', label: 'Claude Code' }, threads: [parseClaudeCodeSession(strip(session), 'f')] });
    expect(old.getEntry(1)!.project).toBeNull();
    expect(old.ingest({ source: { kind: 'claude-code', label: 'Claude Code' }, threads: [parseClaudeCodeSession(session, 'f')] })).toMatchObject({ added: 0, versioned: 0 });
    expect([old.getEntry(1)!.project, old.getEntry(1)!.gitBranch, old.history(1)]).toEqual(['/home/mara/code/plotline', 'main', [expect.objectContaining({ version: 1 })]]);
  });

  it('the CLI gets --project from STORE_FLAGS, with a help line', () => {
    const { values } = parseArgs({ args: ['reminders', '--project', 'plotline'], allowPositionals: true, options: { ...STORE_FLAGS } });
    expect(values.project).toBe('plotline');
    expect(STORE_SEARCH_HELP).toMatch(/^ {6}--project <name> {6}Only coding sessions/);
  });
});
