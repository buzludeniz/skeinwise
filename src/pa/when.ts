// Reads when something is due from plain words, with no model: "tomorrow at 3", "by Friday", "in two weeks",
// "end of the month", "on 4 December", "2026-12-01". Days are local calendar days and times local clock times, read
// against a moment (now for a new task, an entry's date for a loop found in it). The model engine reads the same
// words itself (src/pa/model.ts); this is the No-AI reading and the fallback.

import { localDay } from '../notes.ts';
import { plain } from './cues.ts';

export interface When {
  /** The local day, YYYY-MM-DD. */
  day: string;
  /** The local time, HH:MM, when the words gave one. */
  time: string | null;
  /** The words that said when, as written. */
  phrase: string;
}

interface Found {
  start: number;
  end: number;
}

interface DayFound extends Found {
  date: Date;
  /** A time the day phrase carries itself ("tonight", "in 2 hours"). */
  time?: [number, number];
}

interface TimeFound extends Found {
  time: [number, number];
}

const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const COUNT = `(\\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|(?:a )?couple(?: of)?|(?:a )?few)`;
/** A word in front of a day that belongs to it: "by Friday", "on the 4th", "due tomorrow". */
const LEAD = '(?:(?:on|by|before|until|till|due|for|this|next|coming|this coming)\\s+)?';

function count(word: string): number {
  const w = word.toLowerCase().replace(/^a /, '').replace(/ of$/, '');
  return /^\d+$/.test(w) ? Number(w) : (NUMBERS[w] ?? 1);
}

function startOfDay(d: Date, plus = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plus);
}

/** The next given weekday strictly after the day of `now`. */
function nextWeekday(now: Date, weekday: number): Date {
  const ahead = (weekday - now.getDay() + 7) % 7 || 7;
  return startOfDay(now, ahead);
}

/** A day of a month: this year, or next year when it has passed. */
function dayOfMonth(now: Date, month: number, day: number, year?: number): Date | null {
  const y = year ?? now.getFullYear();
  const d = new Date(y, month, day);
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  if (year === undefined && d < startOfDay(now)) return new Date(y + 1, month, day);
  return d;
}

function all(text: string, re: RegExp): RegExpMatchArray[] {
  return [...text.matchAll(new RegExp(re.source, 'gi'))];
}

function days(text: string, now: Date): DayFound[] {
  const out: DayFound[] = [];
  const add = (m: RegExpMatchArray, date: Date | null, time?: [number, number]) => {
    if (date) out.push({ start: m.index!, end: m.index! + m[0].length, date, ...(time ? { time } : {}) });
  };
  for (const m of all(text, new RegExp(`\\b(?:in|within) ${COUNT} (minute|min|hour|hr|day|week|month)s?\\b`))) {
    const n = count(m[1]!);
    const unit = m[2]!.toLowerCase();
    if (unit.startsWith('min') || unit.startsWith('h')) {
      const at = new Date(now.getTime() + n * (unit.startsWith('h') ? 3_600_000 : 60_000));
      add(m, startOfDay(at), [at.getHours(), at.getMinutes()]);
    } else if (unit === 'month') add(m, new Date(now.getFullYear(), now.getMonth() + n, now.getDate()));
    else add(m, startOfDay(now, n * (unit === 'week' ? 7 : 1)));
  }
  for (const m of all(text, /\b(?:on |by |for )?(?:the )?day after tomorrow\b/)) add(m, startOfDay(now, 2));
  for (const m of all(text, /\b(?:(?:by|for|until|till|due) )?(?:tomorrow|tmrw|tmr)(?: (morning|afternoon|evening|night))?\b/)) {
    if (/day after tomorrow/i.test(text.slice(Math.max(0, m.index! - 14), m.index! + m[0].length))) continue;
    add(m, startOfDay(now, 1), m[1] ? partOfDay(m[1]) : undefined);
  }
  for (const m of all(text, /\b(?:(?:by|for|until|due) )?(today|tonight|this (?:morning|afternoon|evening))\b/)) {
    const word = m[1]!.toLowerCase();
    add(m, startOfDay(now), word === 'today' ? undefined : partOfDay(word.replace('this ', '')));
  }
  for (const m of all(text, new RegExp(`\\b${LEAD}(${WEEKDAYS.join('|')})(?: (morning|afternoon|evening|night))?\\b`))) {
    add(m, nextWeekday(now, WEEKDAYS.indexOf(m[1]!.toLowerCase())), m[2] ? partOfDay(m[2]) : undefined);
  }
  for (const m of all(text, /\b(?:(?:by|before|until|at) )?(?:the )?end of (?:the |this )?(day|week|month)\b/)) {
    const unit = m[1]!.toLowerCase();
    if (unit === 'day') add(m, startOfDay(now), [17, 0]);
    else if (unit === 'week') add(m, startOfDay(now, (5 - now.getDay() + 7) % 7));
    else add(m, new Date(now.getFullYear(), now.getMonth() + 1, 0));
  }
  for (const m of all(text, /\b(?:(?:by|before|until) )?next (week|month)\b/)) {
    // Next week starts on the Monday after this week's Saturday; on a Sunday, that is tomorrow.
    if (m[1]!.toLowerCase() === 'week') add(m, nextWeekday(startOfDay(now, now.getDay() === 0 ? -1 : 6 - now.getDay()), 1));
    else add(m, new Date(now.getFullYear(), now.getMonth() + 1, 1));
  }
  for (const m of all(text, /\b(?:(?:by|over|for|on|at) )?(?:this |the )?weekend\b/)) {
    add(m, now.getDay() === 6 ? startOfDay(now) : startOfDay(now, (6 - now.getDay() + 7) % 7));
  }
  for (const m of all(text, /\b(?:(?:on|by|before|until|due) )?(\d{4})-(\d{2})-(\d{2})\b/)) {
    add(m, dayOfMonth(now, Number(m[2]) - 1, Number(m[3]), Number(m[1])));
  }
  for (const m of all(text, new RegExp(`\\b${LEAD}(?:the )?(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH}\\b`))) {
    add(m, dayOfMonth(now, MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()), Number(m[1])));
  }
  for (const m of all(text, new RegExp(`\\b${LEAD}${MONTH} (\\d{1,2})(?:st|nd|rd|th)?\\b(?!:)`))) {
    add(m, dayOfMonth(now, MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()), Number(m[2])));
  }
  return out;
}

function partOfDay(word: string): [number, number] {
  switch (word.toLowerCase()) {
    case 'morning':
      return [9, 0];
    case 'afternoon':
      return [14, 0];
    case 'evening':
      return [18, 0];
    default:
      return [20, 0];
  }
}

function times(text: string): TimeFound[] {
  const out: TimeFound[] = [];
  const add = (m: RegExpMatchArray, h: number, min: number) => {
    if (h >= 0 && h < 24 && min >= 0 && min < 60) out.push({ start: m.index!, end: m.index! + m[0].length, time: [h, min] });
  };
  for (const m of all(text, /\b(?:at |by |around |from )?(\d{1,2})(?:[:.](\d{2}))? ?([ap])\.?m\.?(?=$|[\s,.;!?)])/)) {
    const h = Number(m[1]) % 12;
    add(m, m[3]!.toLowerCase() === 'p' ? h + 12 : h, Number(m[2] ?? 0));
  }
  for (const m of all(text, /\b(?:at |by |around )?([01]?\d|2[0-3]):([0-5]\d)\b(?! ?[ap]\.?m)/)) add(m, Number(m[1]), Number(m[2]));
  for (const m of all(text, /\b(?:at|by|around) (\d{1,2})\b(?![:.]?\d| ?[ap]\.?m|(?:st|nd|rd|th)\b| (?:of |minute|min|hour|hr|day|week|month))/)) {
    const h = Number(m[1]);
    // "at 3" means the afternoon; "at 9" the morning.
    if (h >= 1 && h <= 12) add(m, h <= 7 ? h + 12 : h === 12 ? 12 : h, 0);
    else add(m, h, 0);
  }
  for (const m of all(text, /\b(?:at |by |around )?noon\b/)) add(m, 12, 0);
  for (const m of all(text, /\bin the (morning|afternoon|evening)\b/)) {
    const [h, min] = partOfDay(m[1]!);
    add(m, h, min);
  }
  return out;
}

function overlaps(a: Found, b: Found): boolean {
  return a.start < b.end && b.start < a.end;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The first "when" in a text, read against `now`, or null when the text names none. */
export function readWhen(text: string, now: Date): When | null {
  const s = plain(text);
  const byPlace = (a: Found, b: Found) => a.start - b.start || b.end - a.end;
  const day = days(s, now).sort(byPlace)[0];
  const time = times(s)
    .filter((t) => !day || !overlaps(t, day))
    .sort(byPlace)[0];
  if (!day && !time) return null;
  const clock = time?.time ?? day?.time ?? null;
  let date = day?.date ?? startOfDay(now);
  // A time with no day is the next time the clock shows it.
  if (!day && clock && (clock[0] < now.getHours() || (clock[0] === now.getHours() && clock[1] <= now.getMinutes()))) date = startOfDay(now, 1);
  const spans: Found[] = [];
  if (day) spans.push(day);
  if (time) spans.push(time);
  spans.sort(byPlace);
  return {
    day: localDay(date),
    time: clock ? `${pad(clock[0])}:${pad(clock[1])}` : null,
    phrase: spans.map((f) => text.slice(f.start, f.end).trim()).join(' '),
  };
}

/** The moment a When points at, in local time: its time, or the given hour when it has none. */
export function whenAt(when: Pick<When, 'day' | 'time'>, hour = 9): Date {
  const [y, m, d] = when.day.split('-').map(Number) as [number, number, number];
  const [h, min] = when.time ? (when.time.split(':').map(Number) as [number, number]) : [hour, 0];
  return new Date(y, m - 1, d, h, min);
}

/** The text with the "when" words taken out, tidied: "Call Ana tomorrow at 3" becomes "Call Ana". */
export function withoutWhen(text: string, now: Date): string {
  const s = plain(text);
  const day = days(s, now).sort((a, b) => a.start - b.start || b.end - a.end)[0];
  const time = times(s)
    .filter((t) => !day || !overlaps(t, day))
    .sort((a, b) => a.start - b.start || b.end - a.end)[0];
  let out = s;
  const spans: Found[] = [];
  if (day) spans.push(day);
  if (time) spans.push(time);
  for (const f of spans.sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, f.start)} ${out.slice(f.end)}`;
  }
  return out
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/(?:\s+(?:on|by|at|before|until|till|due|for|and|,))+\s*([.!?]*)$/i, '$1')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
}
