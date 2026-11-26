import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  addTask,
  assertPaReady,
  dismissReminder,
  dueReminders,
  listTasks,
  readTask,
  removeTask,
  snoozeReminder,
  taskCounts,
  updateTask,
  upcomingReminders,
} from '../../src/pa/tasks.ts';
import { openDb } from '../../src/store/db.ts';

const T0 = '2026-11-25T17:00:00.000Z';
const T1 = '2026-11-25T18:00:00.000Z';

describe('tasks', () => {
  it('adds, lists in the order to do them, finishes and reopens', () => {
    const db = openDb(':memory:');
    const later = addTask(db, { title: 'Renew the van insurance', dueDay: '2026-12-01' }, T0);
    const soon = addTask(db, { title: 'Order rye flour', dueDay: '2026-11-24' }, T0);
    const loose = addTask(db, { title: '  Sort the seed packets  ' }, T0);
    expect(loose.title).toBe('Sort the seed packets');
    expect(listTasks(db).map((t) => t.id)).toEqual([soon.id, later.id, loose.id]);
    expect(taskCounts(db, '2026-11-25', T0)).toEqual({ open: 3, overdue: 1, dueToday: 0, remindersDue: 0 });

    const done = updateTask(db, soon.id, { status: 'done' }, T1);
    expect(done).toMatchObject({ status: 'done', doneAt: T1 });
    expect(listTasks(db).map((t) => t.id)).toEqual([later.id, loose.id]);
    expect(listTasks(db, 'all').map((t) => t.id)).toEqual([later.id, loose.id, soon.id]);
    expect(updateTask(db, soon.id, { status: 'open' }, T1)).toMatchObject({ status: 'open', doneAt: null });
    expect(removeTask(db, loose.id).id).toBe(loose.id);
    expect(() => removeTask(db, loose.id)).toThrow(/No task/);
  });

  it('refuses an empty title, a made-up day, a bad moment and a loop that is already a task', () => {
    const db = openDb(':memory:');
    expect(() => addTask(db, { title: '   ' }, T0)).toThrow(/needs a title/);
    expect(() => addTask(db, { title: 'x'.repeat(301) }, T0)).toThrow(/at most 300/);
    expect(() => addTask(db, { title: 'A', dueDay: '2026-02-30' }, T0)).toThrow(/not a day/);
    expect(() => addTask(db, { title: 'A', remindAt: 'tomorrow' }, T0)).toThrow(/not a moment/);
    expect(() => updateTask(db, 99, { title: 'B' }, T0)).toThrow(/No task 99/);
    addTask(db, { title: 'A', loopKey: 'k1' }, T0);
    expect(() => addTask(db, { title: 'B', loopKey: 'k1' }, T0)).toThrow(/already task 1/);
  });

  it('keeps control characters out of titles and notes', () => {
    const db = openDb(':memory:');
    const t = addTask(db, { title: 'Call \u001b[31mAna‮', notes: 'line one\nline two\u0007' }, T0);
    expect(t.title).toBe('Call Ana');
    expect(t.notes).toBe('line one\nline two');
  });

  it('shows a reminder once its moment passes, until dismissed or snoozed', () => {
    const db = openDb(':memory:');
    const r = addTask(db, { title: 'Call the vet', remindAt: '2026-11-25T17:30:00Z' }, T0);
    expect(dueReminders(db, T0)).toEqual([]);
    expect(upcomingReminders(db, T0).map((t) => t.id)).toEqual([r.id]);
    expect(dueReminders(db, T1).map((t) => t.id)).toEqual([r.id]);
    expect(taskCounts(db, '2026-11-25', T1).remindersDue).toBe(1);

    dismissReminder(db, r.id, T1);
    expect(dueReminders(db, T1)).toEqual([]);

    expect(() => snoozeReminder(db, r.id, T0, T1)).toThrow(/still to come/);
    const snoozed = snoozeReminder(db, r.id, '2026-11-25T19:00:00.000Z', T1);
    expect(snoozed).toMatchObject({ remindAt: '2026-11-25T19:00:00.000Z', remindedAt: null });
    expect(dueReminders(db, '2026-11-25T19:00:00.000Z').map((t) => t.id)).toEqual([r.id]);
    updateTask(db, r.id, { status: 'done' }, T1);
    expect(dueReminders(db, '2026-11-26T00:00:00.000Z')).toEqual([]);
    expect(() => dismissReminder(db, addTask(db, { title: 'No bell' }, T0).id, T1)).toThrow(/no reminder/);
  });

  it('says plainly when the assistant tables are missing', () => {
    expect(() => assertPaReady(new DatabaseSync(':memory:'))).toThrow(/no assistant tables/);
  });
});

describe('readTask', () => {
  // Wednesday 25 November 2026, 10:00 local time.
  const now = new Date(2026, 10, 25, 10, 0);
  const at = (...a: [number, number, number, number, number]) => new Date(...a).toISOString();

  it('reads a reminder with a day and a time', () => {
    expect(readTask('Remind me to call Ana tomorrow at 3', now)).toEqual({ title: 'Call Ana', dueDay: '2026-11-26', remindAt: at(2026, 10, 26, 15, 0) });
  });

  it('reads a task with a day and no reminder', () => {
    expect(readTask('renew the van insurance by Friday', now)).toEqual({ title: 'Renew the van insurance', dueDay: '2026-11-27', remindAt: null });
    expect(readTask('Sort the seed packets', now)).toEqual({ title: 'Sort the seed packets', dueDay: null, remindAt: null });
  });

  it('sets a reminder from a time alone, or at 09:00 on a day with none', () => {
    expect(readTask('Call the vet at 4pm', now)).toEqual({ title: 'Call the vet', dueDay: '2026-11-25', remindAt: at(2026, 10, 25, 16, 0) });
    expect(readTask('remind me to water the starter on Monday', now).remindAt).toBe(at(2026, 10, 30, 9, 0));
    expect(readTask('water the starter', now, true)).toEqual({ title: 'Water the starter', dueDay: '2026-11-26', remindAt: at(2026, 10, 26, 9, 0) });
    expect(readTask('remind me to water the starter today', now).remindAt).toBe(at(2026, 10, 25, 11, 0));
  });

  it('needs something to do', () => {
    expect(() => readTask('remind me to tomorrow', now)).toThrow(/Say what the task is/);
  });
});
