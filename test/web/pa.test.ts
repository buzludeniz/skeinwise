import { describe, expect, it } from 'vitest';
import type { BriefBody } from '../../src/pa/brief.ts';
import { countsLine, dayOn, dueLabel, fmtRemind, fromLocalInput, localDay, olderLine, openLine, snoozeChoices, toLocalInput } from '../../web/src/pa/text.ts';

// Local times throughout, so the tests read the same in any time zone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);

function body(counts: Partial<BriefBody['counts']>, more: Partial<BriefBody> = {}): BriefBody {
  return {
    since: '',
    until: '',
    counts: { entries: 0, yours: 0, threads: 0, notes: 0, edited: 0, older: 0, ...counts },
    older: [],
    threads: [],
    decided: [],
    loops: [],
    questions: [],
    followUps: 0,
    tasks: { open: 0, overdue: 0, dueToday: 0, remindersDue: 0 },
    lines: [],
    ...more,
  };
}

describe('the assistant in the browser', () => {
  it('turns date and time inputs into moments and back, in local time', () => {
    const iso = at(2026, 11, 26, 15, 0).toISOString();
    expect(fromLocalInput('2026-11-26T15:00')).toBe(iso);
    expect(fromLocalInput('2026-11-26T15:00:00')).toBe(iso);
    expect(toLocalInput(iso)).toBe('2026-11-26T15:00');
    expect(fromLocalInput('')).toBeNull();
    expect(toLocalInput(null)).toBe('');
    expect(() => fromLocalInput('tomorrow')).toThrow(/not a date and time/);
    expect(localDay(at(2026, 1, 5))).toBe('2026-01-05');
    expect(dayOn('2026-11-25', 7)).toBe('2026-12-02');
  });

  it('says when a task is due and when a reminder goes off', () => {
    expect(dueLabel('2026-11-24', '2026-11-25')).toEqual({ text: 'overdue, 2026-11-24', late: true });
    expect(dueLabel('2026-11-25', '2026-11-25').text).toBe('today');
    expect(dueLabel('2026-11-26', '2026-11-25').text).toBe('tomorrow');
    expect(dueLabel('2026-11-27', '2026-11-25').text).toBe('Fri');
    expect(dueLabel('2026-12-09', '2026-11-25').text).toBe('2026-12-09');
    const now = at(2026, 11, 25, 17, 0);
    expect(fmtRemind(at(2026, 11, 25, 18, 30).toISOString(), now)).toBe('today 18:30');
    expect(fmtRemind(at(2026, 11, 26, 9, 0).toISOString(), now)).toBe('tomorrow 09:00');
    expect(fmtRemind(at(2026, 11, 30, 9, 0).toISOString(), now)).toBe('Mon 09:00');
    expect(fmtRemind(at(2026, 11, 20, 9, 0).toISOString(), now)).toBe('2026-11-20 09:00');
  });

  it('snoozes to ten minutes, an hour, or tomorrow at nine', () => {
    expect(snoozeChoices(at(2026, 11, 25, 23, 30))).toEqual([
      { label: '10 minutes', until: at(2026, 11, 25, 23, 40).toISOString() },
      { label: '1 hour', until: at(2026, 11, 26, 0, 30).toISOString() },
      { label: 'Tomorrow 09:00', until: at(2026, 11, 26, 9, 0).toISOString() },
    ]);
  });

  it("words the brief's counts as the CLI does", () => {
    expect(countsLine(body({}))).toBe('Nothing new since the last brief.');
    expect(countsLine(body({ entries: 1, yours: 1, notes: 1 }))).toBe('1 new or changed entry (1 yours, 1 note, 0 threads, 0 edited).');
    expect(countsLine(body({ entries: 3, yours: 2, notes: 1, threads: 1, edited: 1 }))).toBe('3 new or changed entries (2 yours, 1 note, 1 thread, 1 edited).');
    expect(olderLine(body({}))).toBeNull();
    expect(olderLine(body({ older: 120 }, { older: [{ source: 'ChatGPT', entries: 120 }] }))).toBe('Also brought in: 120 older from ChatGPT.');
    expect(openLine(body({}, { followUps: 1, tasks: { open: 3, overdue: 1, dueToday: 0, remindersDue: 2 } }))).toBe('Open: 3 tasks, 1 overdue, 2 reminders due; 1 loop to follow up.');
  });
});
