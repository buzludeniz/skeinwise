// The assistant's commands: brief, loops, tasks, task, remind and reminders. The CLI wires PA_COMMANDS into its command
// table, PA_FLAGS into its parser and PA_HELP into its help; each command takes the same Ctx as the organiser's.
// Every one works with no model. `brief` uses the engine in the settings, like `ask`; `loops` reads with a model only
// when --engine names one, since that can take a while.

import type { Ctx } from '../cli-organiser.ts';
import { ENGINES, loadConfig } from '../config.ts';
import { UsageError } from '../errors.ts';
import { localDay, readNotes } from '../notes.ts';
import { createModel } from '../organiser/model.ts';
import { RecordView } from '../organiser/record.ts';
import { briefText, latestBrief } from './brief.ts';
import { findLoopsWith, makeBriefWith, type PaEngine } from './model.ts';
import { LOOP_DAYS, type Loop, loopCounts, loopToTask, setLoopState } from './loops.ts';
import {
  addTask,
  checkDay,
  checkMoment,
  dismissReminder,
  dueReminders,
  listTasks,
  needTask,
  type PaTask,
  readTask,
  REMIND_HOUR,
  removeTask,
  snoozeReminder,
  type TaskPatch,
  updateTask,
  upcomingReminders,
} from './tasks.ts';
import { readWhen, whenAt } from './when.ts';

type Command = (ctx: Ctx) => number | Promise<number>;

/** The flags the assistant's commands read, beyond the ones every command has. */
export interface PaValues {
  due?: string;
  remind?: string;
  all?: boolean;
  days?: string;
  last?: boolean;
  since?: string;
}

export const PA_FLAGS = {
  due: { type: 'string' },
  remind: { type: 'string' },
  all: { type: 'boolean' },
  days: { type: 'string' },
  last: { type: 'boolean' },
  since: { type: 'string' },
} as const;

/** Help text starts in this column; a name too long for it puts its text on the next line. */
const COLUMN = 28;
const row = (head: string, text: string) =>
  head.length <= COLUMN - 2 ? `${head.padEnd(COLUMN)}${text}\n` : `${head}\n${' '.repeat(COLUMN)}${text}\n`;
const line = (command: string, text: string) => row(`  ${command}`, text);
const flag = (name: string, text: string) => row(`      ${name}`, text);
const more = (text: string) => `${' '.repeat(COLUMN)}${text}\n`;

export const PA_HELP =
  'The assistant (works with no model; --engine as for run):\n' +
  line('brief', 'What came in since the last brief: threads, decisions, new loops') +
  flag('--since <date>', 'Cover from this day or moment instead') +
  flag('--last', 'Show the last brief again; make no new one') +
  line('loops', 'Open loops in your own words: promises, to-dos, waits, reminders') +
  flag('--all', 'Every loop, closed ones too') +
  flag('--days <n|all>', `How far back to look (default ${LOOP_DAYS})`) +
  flag('--engine <name>', 'Have a model read your sentences first') +
  line('loops done|drop <loop>', 'Close a loop') +
  line('loops snooze <loop> <day>', 'Hide a loop until a day (YYYY-MM-DD or words like "monday")') +
  line('loops open <loop>', 'Take back what you said about a loop') +
  line('loops task <loop>', 'Make a task from a loop') +
  line('tasks', 'Your open tasks, the ones due soonest first (--all for every task)') +
  line('task add <text>...', 'Add a task; "by Friday" and "tomorrow at 3" are read as its day and time') +
  flag('--due <day|none>', 'The day it is due') +
  flag('--remind <when|none>', 'When to remind you: an ISO time or words like "monday 9am"') +
  line('task edit <task> [<text>...]', 'Change a task\'s title, or with --due and --remind its day and reminder') +
  line('task done|drop|reopen <task>', 'Finish, drop or reopen a task') +
  line('task rm <task>', 'Delete a task') +
  line('remind <text>...', 'Add a reminder: "call Ana tomorrow at 3"; with no time, 09:00') +
  line('reminders', 'Reminders that are due, then the ones to come') +
  line('reminders dismiss <task>', 'Stop showing a due reminder') +
  line('reminders snooze <task> <when>', 'Remind again later: an ISO time or words like "in 2 hours"') +
  more('Reminders show in the app while it is open; nothing runs in the background.');

function values(ctx: Ctx): PaValues {
  return ctx.values as PaValues;
}

function now(ctx: Ctx): string {
  return ctx.io.now ? ctx.io.now() : new Date().toISOString();
}

/** The engine for this command: --engine, or the settings' when `fromSettings`; none otherwise. */
function engine(ctx: Ctx, fromSettings: boolean): PaEngine {
  const config = loadConfig(ctx.home);
  const name = ctx.values.engine ?? (fromSettings ? config.engine : 'none');
  if (!(ENGINES as readonly string[]).includes(name)) throw new UsageError(`Unknown engine "${name}". Use local, remote or none.`);
  if (name === 'none') return { engine: 'none', budget: config.budget };
  const e = name as 'local' | 'remote';
  return { engine: e, budget: config.budget, client: createModel(config, e, { fetch: ctx.io.fetch ?? fetch, env: ctx.io.env, home: ctx.home }) };
}

function record(ctx: Ctx): RecordView {
  readNotes(ctx.store, ctx.home);
  return new RecordView(ctx.store);
}

function id(word: string | undefined, what: string): number {
  if (!word || !/^\d+$/.test(word)) throw new UsageError(`Give the ${what}'s number, for example: skeinwise ${what} done 3`);
  return Number(word);
}

/** A local "YYYY-MM-DD HH:MM" for an ISO moment. */
function local(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${localDay(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** An ISO moment, or words like "monday 9am" or "in 2 hours", as an ISO moment. */
function moment(text: string, at: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return checkMoment(text)!;
  const when = readWhen(text, new Date(at));
  if (!when) throw new UsageError(`"${text}" is not a time I can read. Try "tomorrow at 9", "monday", "in 2 hours" or an ISO time.`);
  return whenAt(when, REMIND_HOUR).toISOString();
}

/** A YYYY-MM-DD day, or words like "friday", as a day. */
function dayOf(text: string, at: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return checkDay(text)!;
  const when = readWhen(text, new Date(at));
  if (!when) throw new UsageError(`"${text}" is not a day I can read. Try YYYY-MM-DD, "friday" or "next week".`);
  return when.day;
}

// Brief

const brief: Command = async (ctx) => {
  const v = values(ctx);
  if (v.last) {
    const last = latestBrief(ctx.store.db);
    if (ctx.values.json) ctx.json(last);
    else ctx.io.out(last ? `${briefText(last)}\n` : 'No brief yet. Make the first with: skeinwise brief\n');
    return 0;
  }
  const at = now(ctx);
  const since = v.since === undefined ? undefined : /^\d{4}-\d{2}-\d{2}$/.test(v.since) ? new Date(`${checkDay(v.since)}T00:00:00`).toISOString() : v.since;
  const { brief: made, message } = await makeBriefWith(record(ctx), { now: at, ...(since !== undefined ? { since } : {}) }, engine(ctx, true));
  if (ctx.values.json) ctx.json({ ...made, message });
  else {
    if (message) ctx.io.err(`${message}\n`);
    ctx.io.out(`${briefText(made)}\n`);
  }
  return 0;
};

// Loops

function loopLine(l: Loop): string {
  const bits = [l.who, l.dueDay ? `due ${l.dueDay}` : null].filter(Boolean).join(', ');
  const state = l.state === 'open' ? (l.followUp ? '  follow up' : '') : `  ${l.state}${l.untilDay ? ` until ${l.untilDay}` : ''}`;
  const task = l.taskId ? `  task ${l.taskId}` : '';
  return `  ${l.key}  ${l.kind.padEnd(8)} ${l.what}${bits ? ` (${bits})` : ''}${state}${task}\n${' '.repeat(l.key.length + 4)}"${l.quote}"  ${l.where}, ${l.date.slice(0, 10)}${l.closedBy ? `; closed by "${l.closedBy.quote}"` : ''}\n`;
}

const loops: Command = async (ctx) => {
  const [action, key, ...rest] = ctx.args;
  const at = now(ctx);
  const rec = record(ctx);
  if (action !== undefined) {
    if (!key) throw new UsageError(`Give the loop, for example: skeinwise loops ${action} 12-0a1b2c3d4e`);
    let changed: Loop | PaTask;
    switch (action) {
      case 'done':
        changed = setLoopState(rec, key, 'done', null, at);
        break;
      case 'drop':
        changed = setLoopState(rec, key, 'dropped', null, at);
        break;
      case 'open':
        changed = setLoopState(rec, key, 'open', null, at);
        break;
      case 'snooze': {
        if (!rest.length) throw new UsageError('Say until when, for example: skeinwise loops snooze 12-0a1b2c3d4e monday');
        changed = setLoopState(rec, key, 'snoozed', dayOf(rest.join(' '), at), at);
        break;
      }
      case 'task':
        changed = loopToTask(rec, key, at);
        break;
      default:
        throw new UsageError(`Unknown loops action "${action}". Use done, drop, snooze, open or task.`);
    }
    if (ctx.values.json) ctx.json(changed);
    else if ('title' in changed) ctx.io.out(`Task ${changed.id}: ${changed.title}${changed.dueDay ? `, due ${changed.dueDay}` : ''}\n`);
    else ctx.io.out(`Loop ${changed.key} is ${changed.state}${changed.untilDay ? ` until ${changed.untilDay}` : ''}: ${changed.what}\n`);
    return 0;
  }
  const v = values(ctx);
  let days: number | null = LOOP_DAYS;
  if (v.days !== undefined) {
    if (v.days === 'all') days = null;
    else if (/^\d+$/.test(v.days) && Number(v.days) > 0) days = Number(v.days);
    else throw new UsageError(`--days takes a number of days or "all", not "${v.days}".`);
  }
  const { loops: found, message } = await findLoopsWith(rec, { now: at, days, include: v.all ? 'all' : 'open' }, engine(ctx, false));
  if (ctx.values.json) {
    ctx.json({ loops: found, message });
    return 0;
  }
  if (message) ctx.io.err(`${message}\n`);
  if (!found.length) {
    ctx.io.out(`No open loops in ${days === null ? 'your record' : `the last ${days} days`}.\n`);
    return 0;
  }
  const c = loopCounts(found);
  ctx.io.out(`${c.open} open ${c.open === 1 ? 'loop' : 'loops'}, ${c.followUp} to follow up${days === null ? '' : ` (last ${days} days)`}:\n`);
  for (const l of found) ctx.io.out(loopLine(l));
  return 0;
};

// Tasks

function taskLine(t: PaTask, today: string): string {
  const box = t.status === 'open' ? '[ ]' : t.status === 'done' ? '[x]' : '[-]';
  const due = t.dueDay ? `  due ${t.dueDay}${t.status === 'open' && t.dueDay < today ? ' (overdue)' : ''}` : '';
  const bell = t.remindAt && t.status === 'open' ? `  remind ${local(t.remindAt)}${t.remindedAt ? ' (dismissed)' : ''}` : '';
  return `  ${String(t.id).padStart(4)}  ${box} ${t.title}${due}${bell}\n`;
}

const tasks: Command = (ctx) => {
  const all = values(ctx).all === true;
  const list = listTasks(ctx.store.db, all ? 'all' : 'open');
  if (ctx.values.json) ctx.json(list);
  else if (!list.length) ctx.io.out(all ? 'No tasks yet. Add one with: skeinwise task add <text>\n' : 'No open tasks.\n');
  else {
    const today = localDay(new Date(now(ctx)));
    for (const t of list) ctx.io.out(taskLine(t, today));
  }
  return 0;
};

/** The patch --due and --remind ask for. */
function datePatch(ctx: Ctx, at: string): TaskPatch {
  const v = values(ctx);
  const patch: TaskPatch = {};
  if (v.due !== undefined) patch.dueDay = v.due === 'none' ? null : dayOf(v.due, at);
  if (v.remind !== undefined) patch.remindAt = v.remind === 'none' ? null : moment(v.remind, at);
  return patch;
}

const task: Command = (ctx) => {
  const [action, ...rest] = ctx.args;
  const at = now(ctx);
  const db = ctx.store.db;
  let result: PaTask;
  switch (action) {
    case 'add': {
      const read = readTask(rest.join(' '), new Date(at));
      result = addTask(db, { ...read, ...datePatch(ctx, at) }, at);
      break;
    }
    case 'edit': {
      const n = id(rest[0], 'task');
      needTask(db, n);
      const patch = datePatch(ctx, at);
      const words = rest.slice(1).join(' ').trim();
      if (words) patch.title = words;
      if (!Object.keys(patch).length) throw new UsageError('Say what to change: new title words, --due or --remind.');
      result = updateTask(db, n, patch, at);
      break;
    }
    case 'done':
      result = updateTask(db, id(rest[0], 'task'), { status: 'done' }, at);
      break;
    case 'drop':
      result = updateTask(db, id(rest[0], 'task'), { status: 'dropped' }, at);
      break;
    case 'reopen':
      result = updateTask(db, id(rest[0], 'task'), { status: 'open' }, at);
      break;
    case 'rm':
      result = removeTask(db, id(rest[0], 'task'));
      if (ctx.values.json) ctx.json(result);
      else ctx.io.out(`Deleted task ${result.id}: ${result.title}\n`);
      return 0;
    default:
      throw new UsageError(action ? `Unknown task action "${action}". Use add, edit, done, drop, reopen or rm.` : 'Say what to do, for example: skeinwise task add call Ana tomorrow');
  }
  if (ctx.values.json) ctx.json(result);
  else ctx.io.out(taskLine(result, localDay(new Date(at))));
  return 0;
};

const remind: Command = (ctx) => {
  const at = now(ctx);
  const read = readTask(ctx.args.join(' '), new Date(at), true);
  const result = addTask(ctx.store.db, { ...read, ...datePatch(ctx, at) }, at);
  if (ctx.values.json) ctx.json(result);
  else ctx.io.out(`Reminder ${result.id}: ${result.title}${result.remindAt ? `, ${local(result.remindAt)}` : ''}\n`);
  return 0;
};

const reminders: Command = (ctx) => {
  const [action, which, ...rest] = ctx.args;
  const at = now(ctx);
  const db = ctx.store.db;
  if (action === 'dismiss' || action === 'snooze') {
    const n = id(which, 'reminder');
    let result: PaTask;
    if (action === 'dismiss') result = dismissReminder(db, n, at);
    else {
      if (!rest.length) throw new UsageError('Say until when, for example: skeinwise reminders snooze 3 in 2 hours');
      result = snoozeReminder(db, n, moment(rest.join(' '), at), at);
    }
    if (ctx.values.json) ctx.json(result);
    else ctx.io.out(action === 'dismiss' ? `Dismissed reminder ${n}.\n` : `Reminder ${n} again at ${local(result.remindAt!)}.\n`);
    return 0;
  }
  if (action !== undefined) throw new UsageError(`Unknown reminders action "${action}". Use dismiss or snooze.`);
  const due = dueReminders(db, at);
  const coming = upcomingReminders(db, at);
  if (ctx.values.json) {
    ctx.json({ due, upcoming: coming });
    return 0;
  }
  if (!due.length && !coming.length) {
    ctx.io.out('No reminders. Add one with: skeinwise remind <text>\n');
    return 0;
  }
  const row = (t: PaTask) => `  ${String(t.id).padStart(4)}  ${local(t.remindAt!)}  ${t.title}\n`;
  if (due.length) ctx.io.out(`Due now:\n${due.map(row).join('')}`);
  if (coming.length) ctx.io.out(`${due.length ? '\n' : ''}Coming:\n${coming.map(row).join('')}`);
  return 0;
};

export const PA_COMMANDS: Record<string, Command> = { brief, loops, tasks, task, remind, reminders };
