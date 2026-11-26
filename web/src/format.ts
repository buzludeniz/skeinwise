// Plain words for numbers and dates. Pure, so the tests can run it without a page.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function toDate(at: string | number | Date): Date {
  return at instanceof Date ? at : new Date(at);
}

/** "3 Nov 2026" (UTC, so a date reads the same on every computer). */
export function fmtDate(at: string | number | Date): string {
  const d = toDate(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A title that is only a date, as a daily note's file name gives it: "2024-11-24". */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The text of a note's first Markdown heading, any level. */
const FIRST_HEADING = /^#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m;

/**
 * The title to show for an entry. A daily note titled only by its date takes its first heading when it has one, else
 * reads "Daily note · Sun 24 Nov 2024". Any other title shows as it is, and an entry without one shows `untitled`.
 */
export function entryTitle(e: { title?: string | null; body?: string | null }, untitled = 'Untitled'): string {
  const title = e.title?.trim() ?? '';
  const date = DATE_ONLY.exec(title);
  if (!date) return title || untitled;
  const heading = e.body ? FIRST_HEADING.exec(e.body)?.[1]?.trim() : undefined;
  if (heading && !DATE_ONLY.test(heading)) return heading;
  const [y, m, d] = [Number(date[1]), Number(date[2]) - 1, Number(date[3])];
  const day = new Date(Date.UTC(y, m, d));
  // "2024-13-45" is not a day: it stays as it was written.
  if (day.getUTCMonth() !== m || day.getUTCDate() !== d) return title;
  return `Daily note · ${DAYS[day.getUTCDay()]} ${fmtDate(day)}`;
}

/** "Nov 2026" from "2026-11" or a date. */
export function fmtMonth(at: string | number | Date): string {
  if (typeof at === 'string' && /^\d{4}-\d{2}$/.test(at)) {
    const [y, m] = at.split('-');
    return `${MONTHS[Number(m) - 1]} ${y}`;
  }
  const d = toDate(at);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A date range in as few words as reads clearly: "3 Nov 2026", "Jan 2024 – Sep 2026". */
export function fmtRange(first: string | null, last: string | null): string {
  if (!first || !last) return '';
  const a = fmtDate(first);
  const b = fmtDate(last);
  if (a === b) return a;
  return `${fmtMonth(first)} – ${fmtMonth(last)}`;
}

/** 1234 → "1,234". */
export function fmtNum(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A model as people name it: a file path or address loses its folders and its .gguf ending. */
export function modelName(model: string): string {
  return model.split(/[\\/]/).pop()!.replace(/\.gguf$/i, '') || model;
}

/** The run counts that name things, in the singular. The rest (tagged, flagged, skipped…) read as they are. */
const COUNTED: Record<string, [string, string]> = {
  entries: ['entry', 'entries'],
  hubs: ['hub', 'hubs'],
  folders: ['folder', 'folders'],
  tags: ['tag', 'tags'],
  notes: ['note', 'notes'],
  reasons: ['reason', 'reasons'],
  ideas: ['idea', 'ideas'],
  hits: ['hit', 'hits'],
  cites: ['citation', 'citations'],
  cross: ['cross link', 'cross links'],
  note: ['note link', 'note links'],
};

/**
 * What a run made, from its counts: "8 hubs, 422 entries, 2 skipped". Zero counts are left out; coverage is a share
 * and byModel counts the entries a model wrote for.
 */
export function runMade(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => {
      if (key === 'coverage') return `${n}% covered`;
      if (key === 'byModel') return `${fmtNum(n)} by the model`;
      const noun = COUNTED[key];
      return noun ? plural(n, noun[0], noun[1]) : `${fmtNum(n)} ${key.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)}`;
    });
  return parts.join(', ') || 'Nothing new';
}

/** 0.4567 → "46%". */
export function fmtShare(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** "1 entry", "12 entries". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}

/** How long ago, in words: "just now", "2 minutes ago", "yesterday", "3 Nov 2026". */
export function ago(at: string | number | Date, now: number = Date.now()): string {
  const t = toDate(at).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return fmtDate(t);
}

/** A byte count in the unit that reads best. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** Speaker names as people read them. */
export function speakerName(s: string): string {
  if (s === 'you') return 'You';
  if (s === 'assistant') return 'Assistant';
  return s;
}
