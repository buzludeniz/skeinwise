// The assistant's words and times in the browser: local days, the values date and time inputs hold, how a due day
// or a reminder reads, and the brief's counts line. Pure, so the tests can check them.

import type { BriefBody } from '../../../src/pa/brief.ts';

const p = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 86_400_000;

/** The local day, YYYY-MM-DD. */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whole local days from one YYYY-MM-DD day to another. */
function daysBetween(from: string, to: string): number {
  const at = (day: string) => {
    const [y, m, d] = day.split('-').map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((at(to) - at(from)) / DAY_MS);
}

/** An ISO moment as a datetime-local input's value, in local time. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${localDay(d)}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A datetime-local input's value ("2026-11-26T15:00", local time) as an ISO moment; empty is null. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) throw new Error(`"${value}" is not a date and time.`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)).toISOString();
}

/** How a due day reads beside a task: "overdue, 24 Nov", "today", "tomorrow", "Fri", or the day. */
export function dueLabel(day: string, today: string): { text: string; late: boolean } {
  const n = daysBetween(today, day);
  if (n < 0) return { text: `overdue, ${day}`, late: true };
  if (n === 0) return { text: 'today', late: false };
  if (n === 1) return { text: 'tomorrow', late: false };
  if (n < 7) {
    const [y, m, d] = day.split('-').map(Number);
    return { text: WEEKDAYS[new Date(y!, m! - 1, d!).getDay()]!, late: false };
  }
  return { text: day, late: false };
}

/** A reminder moment, short: "today 15:00", "tomorrow 09:00", "Fri 09:00", or the day and time. */
export function fmtRemind(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const n = daysBetween(localDay(now), localDay(d));
  if (n === 0) return `today ${time}`;
  if (n === 1) return `tomorrow ${time}`;
  if (n > 1 && n < 7) return `${WEEKDAYS[d.getDay()]} ${time}`;
  return `${localDay(d)} ${time}`;
}

/** Ways to snooze a reminder: ten minutes, an hour, tomorrow at 09:00. */
export function snoozeChoices(now: Date = new Date()): { label: string; until: string }[] {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
  return [
    { label: '10 minutes', until: new Date(now.getTime() + 10 * 60_000).toISOString() },
    { label: '1 hour', until: new Date(now.getTime() + 3_600_000).toISOString() },
    { label: 'Tomorrow 09:00', until: tomorrow.toISOString() },
  ];
}

/** The local day `days` on from a YYYY-MM-DD day. */
export function dayOn(today: string, days: number): string {
  const [y, m, d] = today.split('-').map(Number);
  return localDay(new Date(y!, m! - 1, d! + days));
}

/** "3 new or changed entries (2 yours, 1 note, 1 thread, 1 edited).", worded as the CLI's brief words it. */
export function countsLine(body: BriefBody): string {
  const c = body.counts;
  if (!c.entries && !c.older) return 'Nothing new since the last brief.';
  return `${c.entries} new or changed ${c.entries === 1 ? 'entry' : 'entries'} (${c.yours} yours, ${c.notes} ${c.notes === 1 ? 'note' : 'notes'}, ${c.threads} ${c.threads === 1 ? 'thread' : 'threads'}, ${c.edited} edited).`;
}

/** "Also brought in: 120 older from ChatGPT, 4 older from Notes.", or null. */
export function olderLine(body: BriefBody): string | null {
  if (!body.older.length) return null;
  return `Also brought in: ${body.older.map((o) => `${o.entries} older from ${o.source}`).join(', ')}.`;
}

/** "Open: 3 tasks, 1 overdue; 2 loops to follow up.", as the brief stood when it was made. */
export function openLine(body: BriefBody): string {
  const t = body.tasks;
  const bits = [`${t.open} ${t.open === 1 ? 'task' : 'tasks'}`];
  if (t.overdue) bits.push(`${t.overdue} overdue`);
  if (t.dueToday) bits.push(`${t.dueToday} due today`);
  if (t.remindersDue) bits.push(`${t.remindersDue} ${t.remindersDue === 1 ? 'reminder' : 'reminders'} due`);
  return `Open: ${bits.join(', ')}; ${body.followUps} ${body.followUps === 1 ? 'loop' : 'loops'} to follow up.`;
}
