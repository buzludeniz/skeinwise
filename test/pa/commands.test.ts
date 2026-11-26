import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, saveConfig } from '../../src/config.ts';
import { openHome } from '../../src/home.ts';
import { PA_COMMANDS, PA_FLAGS, PA_HELP } from '../../src/pa/commands.ts';
import type { Store } from '../../src/store/store.ts';
import { context } from '../mcp/helpers.ts';
import { fillRecord, NOW } from './fixture.ts';

// The assistant's commands, called with a context built as the CLI builds it. The record folder holds a settings file
// that points the local engine at a port nobody uses, and every context gets a fetch that fails the test if a command
// reaches for a model it wasn't given.

let home: string;
let store: Store;
let clock: string;
const noNetwork = (async () => {
  throw new Error('This command was not meant to reach a model.');
}) as unknown as typeof fetch;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skeinwise-pa-cmd-'));
  clock = NOW;
  store = fillRecord(openHome(home, () => clock));
  saveConfig(home, { ...DEFAULT_CONFIG, localUrl: 'http://127.0.0.1:8799/v1' });
});
afterEach(() => {
  store.db.close();
  rmSync(home, { recursive: true, force: true });
});

async function run(command: string, args: string[] = [], values: Record<string, unknown> = {}, fetch: typeof globalThis.fetch = noNetwork) {
  const { ctx, output } = context(home, store, { args, values, now: () => clock, fetch });
  const code = await PA_COMMANDS[command]!(ctx);
  return { code, ...output };
}

function fakeModel(content: unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'fake-4b' }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  }) as typeof fetch;
}

describe('the wiring', () => {
  it('exports the commands, flags and help the CLI wires in', () => {
    expect(Object.keys(PA_COMMANDS).sort()).toEqual(['brief', 'loops', 'remind', 'reminders', 'task', 'tasks']);
    expect(Object.keys(PA_FLAGS).sort()).toEqual(['all', 'days', 'due', 'last', 'remind', 'since']);
    for (const c of Object.keys(PA_COMMANDS)) expect(PA_HELP).toMatch(new RegExp(`^  ${c}\\b`, 'm'));
    // A long name never runs into its text ("<task>Finish"): the text goes on the next line, in the same column.
    expect(PA_HELP).not.toMatch(/[a-z>\].][A-Z][a-z]/);
    expect(PA_HELP).toMatch(/^ {2}task done\|drop\|reopen <task>\n {28}Finish/m);
  });
});

describe('skeinwise task and tasks', () => {
  it('adds a task with its day read from the words, lists, edits, finishes and deletes it', async () => {
    expect((await run('tasks')).out).toBe('No open tasks.\n');
    expect((await run('task', ['add', 'renew', 'the', 'van', 'insurance', 'by', 'Friday'])).out).toBe('     1  [ ] Renew the van insurance  due 2026-11-27\n');
    await run('task', ['add', 'order', 'rye', 'flour'], { due: '2026-11-24' });
    expect((await run('tasks')).out).toBe('     2  [ ] Order rye flour  due 2026-11-24 (overdue)\n     1  [ ] Renew the van insurance  due 2026-11-27\n');
    expect((await run('task', ['edit', '1', 'Renew', 'the', 'van', 'and', 'boat', 'insurance'], { due: 'none' })).out).toBe('     1  [ ] Renew the van and boat insurance\n');
    expect((await run('task', ['done', '2'])).out).toBe('     2  [x] Order rye flour  due 2026-11-24\n');
    expect((await run('tasks')).out).not.toContain('rye');
    expect((await run('tasks', [], { all: true })).out).toContain('[x] Order rye flour');
    expect((await run('task', ['rm', '2'])).out).toBe('Deleted task 2: Order rye flour\n');
    expect((await run('tasks', [], { json: true })).json[0]).toMatchObject([{ id: 1, title: 'Renew the van and boat insurance', dueDay: null }]);
  });

  it('says what it needs', async () => {
    await expect(run('task', [])).rejects.toThrow(/task add/);
    await expect(run('task', ['done', 'x'])).rejects.toThrow(/task's number/);
    await expect(run('task', ['done', '7'])).rejects.toThrow(/No task 7/);
    await expect(run('task', ['edit', '7'])).rejects.toThrow(/No task 7/);
    await run('task', ['add', 'water', 'the', 'starter']);
    await expect(run('task', ['edit', '1'])).rejects.toThrow(/Say what to change/);
    await expect(run('task', ['add', 'x'], { due: 'someday' })).rejects.toThrow(/not a day I can read/);
    await expect(run('task', ['fly'])).rejects.toThrow(/Unknown task action/);
  });
});

describe('skeinwise remind and reminders', () => {
  it('adds a reminder, shows it coming and then due, and dismisses or snoozes it', async () => {
    expect((await run('remind', ['call', 'Ana', 'tomorrow', 'at', '3'])).out).toBe('Reminder 1: Call Ana, 2026-11-26 15:00\n');
    expect((await run('reminders')).out).toBe('Coming:\n     1  2026-11-26 15:00  Call Ana\n');
    clock = new Date(2026, 10, 26, 16, 0).toISOString();
    expect((await run('reminders')).out).toBe('Due now:\n     1  2026-11-26 15:00  Call Ana\n');
    expect((await run('reminders', ['snooze', '1', 'in', '2', 'hours'])).out).toBe('Reminder 1 again at 2026-11-26 18:00.\n');
    clock = new Date(2026, 10, 26, 18, 30).toISOString();
    expect((await run('reminders', ['dismiss', '1'])).out).toBe('Dismissed reminder 1.\n');
    expect((await run('reminders')).out).toBe('No reminders. Add one with: skeinwise remind <text>\n');
    await expect(run('reminders', ['snooze', '1'])).rejects.toThrow(/until when/);
    await expect(run('reminders', ['ring'])).rejects.toThrow(/Unknown reminders action/);
  });
});

describe('skeinwise loops', () => {
  it('lists the open loops with no model unless --engine names one', async () => {
    const { out } = await run('loops');
    expect(out).toMatch(/^3 open loops, 1 to follow up \(last 30 days\):\n/);
    expect(out).toMatch(/todo {5}Order more rye flour {2}follow up\n {15,}"\[ \] order more rye flour" {2}2026-11-20, 2026-11-20\n/);
    expect((await run('loops', [], { days: 'all' })).out).toMatch(/^4 open loops, 2 to follow up:/);
    await expect(run('loops', [], { days: 'ten' })).rejects.toThrow(/--days takes/);
  });

  it('closes, snoozes and reopens a loop, and makes a task from one', async () => {
    const json = (await run('loops', [], { json: true })).json[0] as { loops: { key: string; what: string }[] };
    const vet = json.loops.find((l) => l.what === 'Call the vet on Monday')!.key;
    const landlord = json.loops.find((l) => l.what.includes('landlord'))!.key;
    expect((await run('loops', ['task', vet])).out).toBe('Task 1: Call the vet, due 2026-11-30\n');
    expect((await run('loops', ['snooze', landlord, 'friday'])).out).toMatch(/^Loop \S+ is snoozed until 2026-11-27: /);
    expect((await run('loops', ['open', landlord])).out).toMatch(/is open: /);
    expect((await run('loops', ['done', landlord])).out).toMatch(/is done: /);
    expect((await run('loops')).out).toMatch(/^2 open loops/);
    await expect(run('loops', ['done'])).rejects.toThrow(/Give the loop/);
    await expect(run('loops', ['wave', vet])).rejects.toThrow(/Unknown loops action/);
  });

  it('has a model read the sentences first with --engine', async () => {
    const { out, err } = await run('loops', [], { engine: 'local' }, fakeModel({ loops: [] }));
    expect(err).toBe('');
    expect(out).toBe('No open loops in the last 30 days.\n');
  });
});

describe('skeinwise brief', () => {
  it('makes a No-AI brief, then shows the last one again', async () => {
    const { out } = await run('brief', [], { engine: 'none' });
    expect(out).toMatch(/^Brief 1, 2026-11-25: since 2026-11-24 17:00 UTC \(No-AI\)\n1 new or changed entry /);
    expect((await run('brief', [], { last: true })).out).toBe(out);
    expect((await run('brief', [], { engine: 'none', since: '2026-11-20' })).out).toMatch(/^Brief 2, .*\n6 new or changed entries/);
    await expect(run('brief', [], { engine: 'none', since: '2026-13-01' })).rejects.toThrow(/not a day/);
  });

  it('uses the engine in the settings, and keeps the No-AI brief when the model fails', async () => {
    const good = await run('brief', [], {}, fakeModel({ lines: [{ text: 'You sent Ana the river report.', cites: ['E1'] }] }));
    expect(good.out).toMatch(/\(local, fake-4b\)\n.*\n {2}You sent Ana the river report\. \[\d+\]\n/);
    clock = '2026-11-26T08:00:00.000Z';
    store.ingest({ source: { kind: 'notes', label: 'Notes', location: '/invented/notes' }, threads: [], entries: [{ externalId: 'x.md', kind: 'note', speaker: 'you', title: 'X', createdAt: clock, body: 'Decided to bake on Fridays.' }] });
    const bad = await run('brief', [], {}, fakeModel({ lines: 'none' }));
    expect(bad.err).toMatch(/didn't write the brief, so this is the No-AI one/);
    expect(bad.out).toMatch(/\(No-AI\)/);
  });
});
