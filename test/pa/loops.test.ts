import { describe, expect, it } from 'vitest';
import { RecordView } from '../../src/organiser/record.ts';
import { startRun, finishRun } from '../../src/organiser/runs.ts';
import { findLoops, getLoop, loopCounts, loopKey, loopToTask, saidIn, setLoopState } from '../../src/pa/loops.ts';
import { listTasks, updateTask } from '../../src/pa/tasks.ts';
import { NOW, paStore } from './fixture.ts';

function setup() {
  const store = paStore();
  const record = new RecordView(store);
  const byQuote = (quote: string) => {
    const e = record.entries.find((x) => x.body.includes(quote))!;
    return loopKey(e.id, saidIn(e).find((s) => s.sentence.includes(quote))!.sentence);
  };
  return { store, record, byQuote };
}

describe('findLoops', () => {
  it('finds the open loops in your own words of the last 30 days, follow-ups first', () => {
    const { record } = setup();
    const loops = findLoops(record, { now: NOW });
    expect(loops.map((l) => [l.kind, l.what, l.followUp])).toEqual([
      ['todo', 'Order more rye flour', true],
      ...[
        ['waiting', "Haven't heard back from the landlord", false],
        ['reminder', 'Call the vet on Monday', false],
      ].sort((a, b) => (loops.findIndex((l) => l.what === a[1]) - loops.findIndex((l) => l.what === b[1]))),
    ]);
    const vet = loops.find((l) => l.kind === 'reminder')!;
    expect(vet).toMatchObject({ dueDay: '2026-11-30', where: 'Market', state: 'open', by: 'none', taskId: null, age: 1 });
    expect(loopCounts(loops)).toEqual({ open: 3, followUp: 1 });
  });

  it('closes a loop when a later sentence of yours says it is done', () => {
    const { record } = setup();
    const all = findLoops(record, { now: NOW, include: 'all' });
    const report = all.find((l) => l.kind === 'promise')!;
    expect(report).toMatchObject({ what: 'Send Ana the river report by Friday', who: 'Ana', dueDay: '2026-11-27', state: 'done' });
    expect(report.closedBy?.quote).toBe('Sent Ana the river report.');
    const kiln = all.find((l) => l.what.startsWith('Book the kiln slot'))!;
    expect(kiln).toMatchObject({ state: 'done', where: 'Stall prices' });
  });

  it('leaves out the assistant, coding sessions, what is said to the assistant and planted future entries', () => {
    const { record } = setup();
    const quotes = findLoops(record, { now: NOW, days: null, include: 'all' }).map((l) => l.quote);
    expect(quotes).not.toContain("I'll send you the price list.");
    expect(quotes).not.toContain("I'll send you a summary.");
    expect(quotes).not.toContain('I need to fix the failing test.');
    expect(quotes).not.toContain("I'll pay Ben back.");
    expect(quotes).not.toContain('I should have sent it last week.');
  });

  it('looks further back when asked', () => {
    const { record } = setup();
    const van = findLoops(record, { now: NOW, days: null }).find((l) => l.what === 'Renew the van insurance');
    expect(van).toMatchObject({ followUp: true, age: 85 });
  });
});

describe('what you say about a loop', () => {
  it('marks one done, dropped or snoozed, and opens it again', () => {
    const { record, byQuote } = setup();
    const key = byQuote('heard back from the landlord');
    expect(setLoopState(record, key, 'done', null, NOW).state).toBe('done');
    expect(findLoops(record, { now: NOW }).map((l) => l.key)).not.toContain(key);
    expect(setLoopState(record, key, 'open', null, NOW).state).toBe('open');
    expect(() => setLoopState(record, key, 'snoozed', '2026-11-25', NOW)).toThrow(/still to come/);
    expect(setLoopState(record, key, 'snoozed', '2026-11-28', NOW)).toMatchObject({ state: 'snoozed', untilDay: '2026-11-28' });
    expect(findLoops(record, { now: NOW }).map((l) => l.key)).not.toContain(key);
    // Once the day comes, it is back and due a follow-up.
    expect(findLoops(record, { now: '2026-11-28T17:00:00.000Z' }).find((l) => l.key === key)).toMatchObject({ state: 'open', followUp: true });
    expect(setLoopState(record, key, 'dropped', null, NOW).state).toBe('dropped');
  });

  it('turns a loop into a task, and the task closes it', () => {
    const { store, record, byQuote } = setup();
    const key = byQuote('call the vet');
    const task = loopToTask(record, key, NOW);
    expect(task).toMatchObject({ title: 'Call the vet', dueDay: '2026-11-30', loopKey: key, madeBy: 'none' });
    expect(task.notes).toBe('From Market, 2026-11-24: "Remind me to call the vet on Monday."');
    expect(getLoop(record, key, NOW)).toMatchObject({ state: 'open', taskId: task.id });
    expect(() => loopToTask(record, key, NOW)).toThrow(/already task/);
    updateTask(store.db, task.id, { status: 'done' }, NOW);
    expect(getLoop(record, key, NOW).state).toBe('done');
    expect(listTasks(store.db, 'all')).toHaveLength(1);
  });

  it('refuses a key that is not a loop', () => {
    const { record, byQuote } = setup();
    expect(() => getLoop(record, 'nonsense', NOW)).toThrow(/not a loop/);
    expect(() => getLoop(record, '9999-0123456789', NOW)).toThrow(/entry is gone/);
    expect(() => getLoop(record, byQuote('Fed the starter'), NOW)).toThrow(/isn't a loop/);
  });
});

describe("a model's reading", () => {
  it('wins for every sentence it read: it can drop a cue loop and add one the cues missed', () => {
    const { store, record, byQuote } = setup();
    const landlord = byQuote('heard back from the landlord');
    const starter = byQuote('Fed the starter');
    const entryOf = (key: string) => Number(key.split('-')[0]);
    const run = startRun(store.db, { task: 'ask', engine: 'local', model: 'fake-4b', scope: 'all', mark: 0, detail: { pa: 'loops' }, now: NOW });
    const insert = store.db.prepare('INSERT INTO pa_found (run_id, key, entry_id, is_loop, kind, what, who, due_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(run, landlord, entryOf(landlord), 0, null, null, null, null);
    insert.run(run, starter, entryOf(starter), 1, 'todo', 'Feed the starter again', null, '2026-11-21');
    // A run still going counts for nothing.
    expect(findLoops(record, { now: NOW }).map((l) => l.key)).toContain(landlord);
    finishRun(store.db, run, { counts: {}, tokensIn: 0, tokensOut: 0, now: NOW });
    const loops = findLoops(record, { now: NOW });
    expect(loops.map((l) => l.key)).not.toContain(landlord);
    expect(loops.find((l) => l.key === starter)).toMatchObject({ what: 'Feed the starter again', by: 'local', followUp: true, kind: 'todo' });
  });
});
