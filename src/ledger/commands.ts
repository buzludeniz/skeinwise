// `skeinwise ledger`: verify walks the ledger's chain and checks the record against it; stamp dates the latest line
// with OpenTimestamps; collect fetches finished proofs later. Stamp and collect show what they would send, and to
// whom, and ask first (--yes skips the question). Nothing here contacts a server without one of them.

import type { Ctx } from '../cli-organiser.ts';
import { UsageError } from '../errors.ts';
import { minute } from '../format.ts';
import { catchUpLedger, checkChain, type LedgerCheck, checkLedger, ledgerPath, lineHash, readLedgerText } from './ledger.ts';
import { allowedCalendar, collect, DEFAULT_CALENDARS, serializeProof, stamp } from './ots.ts';
import { proofPath, readStamps, type Stamp, writeProof } from './stamps.ts';

type Command = (ctx: Ctx) => Promise<number>;

/** The help lines for the CLI's help text. */
export const LEDGER_HELP = `Ledger and proof of date (ledger.jsonl in the record folder):
  ledger verify             Check the ledger's chain, the record against it, and its stamps
  ledger stamp              Date the ledger's latest line with OpenTimestamps, after showing
                            what goes to which calendar servers and asking
      --yes                 Send without asking
  ledger collect            Fetch finished stamps from the calendar servers, after asking
      --yes                 Ask the servers without asking first
`;

/** The flags the ledger reads; cli.ts's parser has them already. */
export const LEDGER_FLAGS = {
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
} as const;

const ledger: Command = async (ctx) => {
  const [what, ...rest] = ctx.args;
  if (what && rest.length) throw new UsageError(`ledger ${what} takes no more words.`);
  switch (what) {
    case 'verify':
      return verify(ctx);
    case 'stamp':
      return stampCommand(ctx);
    case 'collect':
      return collectCommand(ctx);
    default:
      throw new UsageError('Give one of: skeinwise ledger verify, skeinwise ledger stamp, skeinwise ledger collect');
  }
};

/** The ledger's commands by name. */
export const LEDGER_COMMANDS: Record<string, Command> = { ledger };

function say(ctx: Ctx, text: string): void {
  ctx.io.out(text.endsWith('\n') ? text : `${text}\n`);
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function list(items: string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function stampLine(s: Stamp): string {
  if (s.state === 'bad') return `  line ${s.line}: ${s.problem}`;
  if (s.state === 'pending') {
    return `  line ${s.line}: waiting for Bitcoin at ${list(s.calendars.map(host))}. Collect it a few hours after stamping: skeinwise ledger collect`;
  }
  const block = s.blocks[0]!;
  return `  line ${s.line}: in Bitcoin block ${block.height}. A block explorer shows that block's merkle root as ${block.merkleRoot}`;
}

function stampJson(s: Stamp) {
  return { line: s.line, path: s.path, state: s.state, blocks: s.blocks, calendars: s.calendars, problem: s.problem };
}

// verify

async function verify(ctx: Ctx): Promise<number> {
  const text = readLedgerText(ctx.home);
  const check: LedgerCheck = checkLedger(ctx.store, ctx.home);
  const stamps = readStamps(ctx.home, text);
  const ok = !check.chain && !check.record && stamps.every((s) => s.state !== 'bad');
  if (ctx.values.json) {
    ctx.json({ ok, path: ledgerPath(ctx.home), ...check, stamps: stamps.map(stampJson) });
    return ok ? 0 : 1;
  }
  if (!check.lines) {
    say(ctx, 'The ledger is empty. It takes in the whole record at the next import, run or stamp, and each one after that.');
    return ok ? 0 : 1;
  }
  say(ctx, `${ledgerPath(ctx.home)}: ${plural(check.lines, 'line')}, written ${minute(check.first ?? '')} to ${minute(check.last ?? '')}.`);
  if (check.chain) say(ctx, `The chain breaks at line ${check.chain.line}. ${check.chain.problem}`);
  else say(ctx, 'The chain holds: no line was changed, added or removed, back to line 1.');
  if (check.record) say(ctx, `The record doesn't match the ledger. ${check.record.problem}`);
  else say(ctx, `The record matches it: ${plural(check.versions, 'version')} checked against their text.`);
  const { versions, runs } = check.behind;
  if (versions || runs) {
    const parts = [versions ? plural(versions, 'version') : '', runs ? plural(runs, 'run') : ''].filter(Boolean);
    say(ctx, `Not in the ledger yet: ${parts.join(' and ')}. They go in at the next import, run or stamp.`);
  }
  if (stamps.length) {
    say(ctx, 'Stamps:');
    for (const s of stamps) say(ctx, stampLine(s));
  } else {
    say(ctx, 'No stamps yet. Date the ledger with: skeinwise ledger stamp');
  }
  return ok ? 0 : 1;
}

// stamp

async function confirm(ctx: Ctx, question: string, refusal: string): Promise<boolean> {
  if (ctx.values.yes) return true;
  const answer = ctx.io.ask ? await ctx.io.ask(question) : null;
  if (answer === null) throw new UsageError(refusal);
  return /^y(es)?$/i.test(answer.trim());
}

async function stampCommand(ctx: Ctx): Promise<number> {
  catchUpLedger(ctx.store, ctx.home);
  const text = readLedgerText(ctx.home);
  if (!text.lines.length) throw new UsageError('The ledger is empty, so there is nothing to stamp yet. Import something first.');
  const broken = checkChain(text);
  if (broken) {
    throw new UsageError(`The ledger's chain breaks at line ${broken.line}, so a stamp would date a damaged ledger. See: skeinwise ledger verify`);
  }
  const line = text.lines.length;
  const hash = lineHash(text.lines[line - 1]!);
  const path = proofPath(ctx.home, line);
  const already = readStamps(ctx.home, text).find((s) => s.line === line && s.state !== 'bad');
  if (already) {
    if (ctx.values.json) ctx.json({ line, hash, path, stamped: false, state: already.state });
    else say(ctx, `Line ${line} is stamped already, so nothing was sent.\n${stampLine(already)}`);
    return 0;
  }
  const calendars = DEFAULT_CALENDARS;
  if (!ctx.values.json) {
    say(ctx, `Stamping dates line ${line} of the ledger (hash ${hash}) and, through its chain, every line before it.`);
    say(ctx, `It sends one hash to ${plural(calendars.length, 'OpenTimestamps calendar server')}: ${list(calendars.map(host))}.`);
    say(ctx, "That hash is worked out from the line's hash and a random number, so it tells them nothing about your record.");
  }
  if (!(await confirm(ctx, 'Send it now? [y/N] ', 'Add --yes to send it.'))) {
    say(ctx, 'Nothing was sent.');
    return 0;
  }
  const result = await stamp(Buffer.from(hash, 'hex'), { calendars, fetch: ctx.io.fetch ?? fetch });
  writeProof(path, serializeProof(result.proof));
  if (ctx.values.json) {
    ctx.json({ line, hash, path, stamped: true, calendars: result.answered, failed: result.failed });
    return 0;
  }
  say(ctx, `Stamped line ${line} at ${list(result.answered.map(host))}. The proof is in ${path}.`);
  for (const f of result.failed) say(ctx, `  ${host(f.calendar)} didn't take it: ${f.reason}`);
  say(ctx, 'The calendars put it into Bitcoin within a few hours. Then fetch the finished proof with: skeinwise ledger collect');
  return 0;
}

// collect

async function collectCommand(ctx: Ctx): Promise<number> {
  const text = readLedgerText(ctx.home);
  const stamps = readStamps(ctx.home, text);
  const pending = stamps.filter((s) => s.state === 'pending');
  if (!pending.length) {
    if (ctx.values.json) ctx.json({ asked: [], stamps: stamps.map(stampJson) });
    else if (!stamps.length) say(ctx, 'Nothing is stamped yet. Date the ledger with: skeinwise ledger stamp');
    else say(ctx, `No stamp is waiting.\n${stamps.map(stampLine).join('\n')}`);
    return stamps.some((s) => s.state === 'bad') ? 1 : 0;
  }
  const askable = [...new Set(pending.flatMap((s) => s.calendars).filter((c) => allowedCalendar(c)))];
  if (askable.length) {
    if (!ctx.values.json) {
      say(ctx, `Collecting asks ${list(askable.map(host))} whether the ${pending.length === 1 ? 'stamp' : 'stamps'} of line ${list(pending.map((s) => String(s.line)))} ${pending.length === 1 ? 'is' : 'are'} in Bitcoin yet.`);
      say(ctx, "It sends each calendar only the hash it was given when the line was stamped.");
    }
    if (!(await confirm(ctx, 'Ask them now? [y/N] ', 'Add --yes to ask them.'))) {
      say(ctx, 'Nothing was sent.');
      return 0;
    }
  }
  const report = [];
  let asked = 0;
  let failed = 0;
  for (const s of pending) {
    const result = await collect(s.proof!, { fetch: ctx.io.fetch ?? fetch });
    if (result.changed) writeProof(s.path, serializeProof(s.proof!));
    asked += result.waiting.length + result.failed.length + (result.changed ? 1 : 0);
    failed += result.failed.length;
    report.push({ stamp: s, result });
  }
  const after = readStamps(ctx.home, text);
  if (ctx.values.json) {
    ctx.json({
      asked: askable,
      stamps: after.map(stampJson),
      failed: report.flatMap((r) => r.result.failed.map((f) => ({ line: r.stamp.line, ...f }))),
      skipped: report.flatMap((r) => r.result.skipped.map((calendar) => ({ line: r.stamp.line, calendar }))),
    });
  } else {
    for (const { stamp: s, result } of report) {
      const now = after.find((a) => a.line === s.line)!;
      if (now.state === 'bitcoin') say(ctx, stampLine(now));
      else if (result.waiting.length) say(ctx, `  line ${s.line}: not in Bitcoin yet at ${list(result.waiting.map(host))}. That usually takes a few hours; try again later.`);
      for (const f of result.failed) say(ctx, `  line ${s.line}: ${host(f.calendar)} couldn't be asked: ${f.reason}`);
      for (const c of result.skipped) say(ctx, `  line ${s.line}: not asked ${c}, because it isn't a known OpenTimestamps calendar.`);
    }
  }
  // Every request failing (no network, say) is an error; a stamp that is still waiting is not.
  return failed && failed === asked ? 1 : 0;
}
