// The assistant's API: today at a glance, the brief, open loops, tasks and reminders. app.ts spreads paRoutes(...) into
// its route table, so every route here sits behind the same token, origin and lock checks as the rest of /api, and its
// errors map the same way (a UsageError is a 400). Everything works with no model; the brief uses the engine in the
// settings, and the loop reading the one the request names.

import { UsageError } from '../errors.ts';
import { localDay, readNotes } from '../notes.ts';
import type { ModelDeps } from '../organiser/model.ts';
import { RecordView } from '../organiser/record.ts';
import { latestBrief, newSinceBrief } from '../pa/brief.ts';
import { findLoops, LOOP_DAYS, type LoopState, loopCounts, loopToTask, setLoopState } from '../pa/loops.ts';
import { findLoopsWith, makeBriefWith } from '../pa/model.ts';
import {
  addTask,
  dismissReminder,
  dueReminders,
  listTasks,
  NOTES_MAX,
  readTask,
  removeTask,
  snoozeReminder,
  type TaskPatch,
  type TaskStatus,
  TITLE_MAX,
  taskCounts,
  upcomingReminders,
  updateTask,
} from '../pa/tasks.ts';
import type { Store } from '../store/store.ts';
// app.ts imports this file too once the routes are wired; HttpError is only used inside handlers, so the cycle is safe.
import { HttpError } from './app.ts';
import { pickEngine } from './organiser.ts';

/** The part of app.ts's request a handler here reads. */
export interface PaRequest {
  url: URL;
  params: string[];
  json: () => Promise<Record<string, unknown>>;
}

export type PaRoute = [method: string, path: RegExp, handler: (req: PaRequest) => unknown];

export interface PaRoutesContext {
  store: Store;
  home: string;
  deps: () => ModelDeps;
}

const LOOP_STATES: readonly LoopState[] = ['open', 'done', 'dropped', 'snoozed'];
const LOOP = '(\\d+-[0-9a-f]{10})';

function id(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Not an id');
  return n;
}

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string') throw new HttpError(400, `${what} must be text`);
  if (value.length > max) throw new HttpError(413, `${what} is too long`);
  return value;
}

/** A field that may be text or null, or left out. */
function maybe(body: Record<string, unknown>, field: string, max: number): string | null | undefined {
  if (!(field in body) || body[field] === undefined) return undefined;
  return body[field] === null ? null : text(body[field], field, max);
}

/** How far back to look for loops: a number of days or "all"; the default when left out. */
function days(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return LOOP_DAYS;
  if (value === 'all') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 36_500) throw new HttpError(400, 'days is a number of days or "all"');
  return n;
}

/** A missing task or loop is a 404, without the CLI's hint. */
function found<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof UsageError && /^No (task|loop) /.test(error.message)) {
      throw new HttpError(404, error.message.replace(/ Run "[^"]*" for the list\.$/, ''));
    }
    throw error;
  }
}

/** dueDay and remindAt as the body gives them; tasks.ts checks they are a day and a moment. */
function datePatch(body: Record<string, unknown>): Pick<TaskPatch, 'dueDay' | 'remindAt'> {
  const patch: Pick<TaskPatch, 'dueDay' | 'remindAt'> = {};
  const due = maybe(body, 'dueDay', 10);
  const remind = maybe(body, 'remindAt', 40);
  if (due !== undefined) patch.dueDay = due;
  if (remind !== undefined) patch.remindAt = remind;
  return patch;
}

export function paRoutes({ store, home, deps }: PaRoutesContext): PaRoute[] {
  const db = store.db;
  const now = () => store.now();
  const record = () => {
    readNotes(store, home);
    return new RecordView(store);
  };

  return [
    // Today: the last brief, how much came in since, the task counts and the reminders due. No record walk, so the page
    // can load it often.
    ['GET', /^\/api\/pa\/today$/, () => {
      readNotes(store, home);
      const at = now();
      return {
        day: localDay(new Date(at)),
        brief: latestBrief(db),
        newSinceBrief: newSinceBrief(db),
        tasks: taskCounts(db, localDay(new Date(at)), at),
        reminders: dueReminders(db, at),
      };
    }],
    ['POST', /^\/api\/pa\/brief$/, async (req) => {
      const body = await req.json();
      const since = maybe(body, 'since', 40) ?? undefined;
      const engine = pickEngine(home, body.engine, deps());
      return makeBriefWith(record(), { now: now(), ...(since !== undefined ? { since } : {}) }, engine);
    }],

    // Loops: the cue reading, or with POST .../find a model's reading first.
    ['GET', /^\/api\/pa\/loops$/, (req) => {
      const d = days(req.url.searchParams.get('days'));
      const loops = findLoops(record(), { now: now(), days: d, include: req.url.searchParams.get('all') === '1' ? 'all' : 'open' });
      return { loops, counts: loopCounts(loops), days: d, read: null, message: null };
    }],
    ['POST', /^\/api\/pa\/loops\/find$/, async (req) => {
      const body = await req.json();
      const d = days(body.days);
      const engine = pickEngine(home, body.engine, deps());
      const { loops, read, message } = await findLoopsWith(record(), { now: now(), days: d, include: body.all === true ? 'all' : 'open' }, engine);
      return { loops, counts: loopCounts(loops), days: d, read, message };
    }],
    ['POST', new RegExp(`^/api/pa/loops/${LOOP}$`), async (req) => {
      const body = await req.json();
      const state = body.state as LoopState;
      if (!LOOP_STATES.includes(state)) throw new HttpError(400, 'state is open, done, dropped or snoozed');
      const until = state === 'snoozed' ? text(body.until, 'until', 10) : null;
      return found(() => setLoopState(record(), req.params[0]!, state, until, now()));
    }],
    ['POST', new RegExp(`^/api/pa/loops/${LOOP}/task$`), (req) => found(() => loopToTask(record(), req.params[0]!, now()))],

    // Tasks. A new one is read from its words ("call Ana tomorrow at 3"); dueDay and remindAt in the body win.
    ['GET', /^\/api\/pa\/tasks$/, (req) => listTasks(db, req.url.searchParams.get('all') === '1' ? 'all' : 'open')],
    ['POST', /^\/api\/pa\/tasks$/, async (req) => {
      const body = await req.json();
      const at = now();
      const read = readTask(text(body.text, 'text', TITLE_MAX * 2), new Date(at), body.reminder === true);
      return addTask(db, { ...read, ...datePatch(body) }, at);
    }],
    ['PUT', /^\/api\/pa\/tasks\/(\d+)$/, async (req) => {
      const body = await req.json();
      const patch: TaskPatch = datePatch(body);
      const title = maybe(body, 'title', TITLE_MAX * 2);
      const notes = maybe(body, 'notes', NOTES_MAX);
      const status = maybe(body, 'status', 10);
      if (title !== undefined) patch.title = title ?? '';
      if (notes !== undefined) patch.notes = notes ?? '';
      if (status !== undefined) patch.status = status as TaskStatus;
      return found(() => updateTask(db, id(req.params[0]), patch, now()));
    }],
    ['POST', /^\/api\/pa\/tasks\/(\d+)\/delete$/, (req) => found(() => removeTask(db, id(req.params[0])))],

    // Reminders: the app polls this while it is open; nothing runs in the background.
    ['GET', /^\/api\/pa\/reminders$/, () => {
      const at = now();
      return { due: dueReminders(db, at), upcoming: upcomingReminders(db, at) };
    }],
    ['POST', /^\/api\/pa\/reminders\/(\d+)\/dismiss$/, (req) => found(() => dismissReminder(db, id(req.params[0]), now()))],
    ['POST', /^\/api\/pa\/reminders\/(\d+)\/snooze$/, async (req) => {
      const body = await req.json();
      return found(() => snoozeReminder(db, id(req.params[0]), text(body.until, 'until', 40), now()));
    }],
  ];
}
