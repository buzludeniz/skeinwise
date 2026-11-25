// Google Calendar, read-only: one thread per calendar, one entry per event. The first pull reads the events from the
// --from date on; later pulls ask only for what changed, with the calendar's sync token. It never creates, changes or
// answers an event. Shapes from the Calendar API v3 reference (calendars.get, events.list, incremental sync).

import { isObj, stripHtml } from '../importers/util.ts';
import type { EntryInput } from '../store/store.ts';
import { ApiError } from './http.ts';
import { GOOGLE } from './oauth.ts';
import { googleRevoke } from './gmail.ts';
import type { Connector, PullContext } from './types.ts';

const BASE = 'https://www.googleapis.com/calendar/v3';
/** Pages of 250 events read per calendar per pull; the next pull carries on from the saved page. */
const PAGES_PER_PULL = 8;

interface CalendarCursor {
  title: string;
  /** Google's token for "what changed since"; absent until a full listing finishes. */
  syncToken?: string;
  /** Where an unfinished listing stopped. */
  pageToken?: string;
}

interface When {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface Person {
  email?: string;
  displayName?: string;
  self?: boolean;
  resource?: boolean;
}

interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  created?: string;
  start?: When;
  end?: When;
  recurrence?: string[];
  organizer?: Person;
  creator?: Person;
  attendees?: Person[];
}

interface EventsPage {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export const calendar: Connector = {
  service: 'calendar',
  label: 'Google Calendar',
  reads: 'the events on the calendars you pick (your main one by default) from the --from date on, then changes as they happen',
  scopes: [
    {
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      why: 'read your calendars and their events; it cannot create, change, delete or answer anything',
    },
  ],
  signIn: { kind: 'oauth', provider: GOOGLE },
  picks: { flag: 'calendars', what: 'calendars (their IDs, from Google Calendar\'s settings)', fallback: ['primary'] },
  async identify(api) {
    const primary = (await api.get(`${BASE}/calendars/primary`)) as { id?: string } | null;
    if (!primary?.id) throw new Error('Google Calendar did not say which account this is.');
    return primary.id;
  },
  pull: pullCalendar,
  revoke: googleRevoke,
};

async function pullCalendar(ctx: PullContext): Promise<void> {
  const cursors = readCursors(ctx.cursor);
  for (const pick of ctx.picks.length ? ctx.picks : ['primary']) {
    let c = cursors[pick];
    if (!c) {
      const cal = (await ctx.api.get(`${BASE}/calendars/${encodeURIComponent(pick)}`)) as { summary?: string } | null;
      c = { title: cal?.summary || pick };
    }
    for (let page = 0; page < PAGES_PER_PULL; page++) {
      let res: EventsPage;
      try {
        res = (await ctx.api.get(`${BASE}/calendars/${encodeURIComponent(pick)}/events`, {
          maxResults: 250,
          // With a sync token Google allows no time window; without one, a full listing from --from on.
          ...(c.syncToken ? { syncToken: c.syncToken } : { timeMin: ctx.since }),
          pageToken: c.pageToken,
        })) as EventsPage;
      } catch (error) {
        // 410 Gone: the sync token ran out. List everything again; what the record has stays unchanged.
        if (error instanceof ApiError && error.status === 410 && (c.syncToken || c.pageToken)) {
          c = { title: c.title };
          continue;
        }
        throw error;
      }
      const entries: EntryInput[] = [];
      for (const event of res.items ?? []) {
        if (event.status === 'cancelled') ctx.deleted(1);
        else entries.push(toEntry(event, ctx.account));
      }
      ctx.emit([{ externalId: pick, title: c.title, entries }]);
      c = res.nextPageToken
        ? { title: c.title, ...(c.syncToken ? { syncToken: c.syncToken } : {}), pageToken: res.nextPageToken }
        : { title: c.title, ...(res.nextSyncToken ? { syncToken: res.nextSyncToken } : {}) };
      cursors[pick] = c;
      ctx.save({ calendars: cursors });
      if (!c.pageToken) break;
    }
  }
}

function readCursors(raw: unknown): Record<string, CalendarCursor> {
  const out: Record<string, CalendarCursor> = {};
  const calendars = isObj(raw) && isObj(raw.calendars) ? raw.calendars : {};
  for (const [id, c] of Object.entries(calendars)) {
    if (!isObj(c) || typeof c.title !== 'string') continue;
    out[id] = { title: c.title };
    if (typeof c.syncToken === 'string') out[id].syncToken = c.syncToken;
    if (typeof c.pageToken === 'string') out[id].pageToken = c.pageToken;
  }
  return out;
}

function toEntry(e: CalendarEvent, account: string): EntryInput {
  const title = e.summary?.trim() || '(no title)';
  const lines = [title, `When: ${when(e.start, e.end)}`];
  if (e.location) lines.push(`Where: ${e.location}`);
  const people = (e.attendees ?? []).filter((a) => !a.resource && !a.self).map((a) => a.displayName || a.email || '');
  if (people.filter(Boolean).length) lines.push(`With: ${people.filter(Boolean).join(', ')}`);
  const rule = e.recurrence?.find((r) => r.startsWith('RRULE:'));
  if (rule) lines.push(`Repeats: ${rule.slice('RRULE:'.length)}`);
  if (e.description) lines.push('', stripHtml(e.description));
  const organiser = e.organizer ?? e.creator;
  const yours = organiser?.self || organiser?.email?.toLowerCase() === account.toLowerCase();
  const start = startIso(e.start);
  return {
    externalId: e.id,
    kind: 'message',
    speaker: yours ? 'you' : organiser?.displayName || organiser?.email || 'someone',
    title,
    createdAt: e.created ?? start,
    body: lines.join('\n'),
    // A calendar reads in the order its events happen.
    seq: Math.floor(Date.parse(start) / 1000),
  };
}

function startIso(w: When | undefined): string {
  const at = Date.parse(w?.dateTime ?? w?.date ?? '');
  return new Date(Number.isNaN(at) ? 0 : at).toISOString();
}

/** "2026-11-24 10:00 to 10:30", "2026-11-24 (all day)", "2026-11-24 to 2026-11-26 (all day)". Times as Google gave them. */
export function when(start: When | undefined, end: When | undefined): string {
  if (start?.date) {
    // An all-day event's end date is the day after it ends.
    const last = end?.date ? new Date(Date.parse(end.date) - 86_400_000).toISOString().slice(0, 10) : start.date;
    return last > start.date ? `${start.date} to ${last} (all day)` : `${start.date} (all day)`;
  }
  const s = start?.dateTime ?? '';
  const e = end?.dateTime ?? '';
  const zone = start?.timeZone ? ` (${start.timeZone})` : '';
  const sDay = s.slice(0, 10);
  const sTime = s.slice(11, 16);
  if (!e) return `${sDay} ${sTime}${zone}`;
  const eText = e.slice(0, 10) === sDay ? e.slice(11, 16) : `${e.slice(0, 10)} ${e.slice(11, 16)}`;
  return `${sDay} ${sTime} to ${eText}${zone}`;
}
