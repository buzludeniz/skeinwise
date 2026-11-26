// `skeinwise setup`: the first command after install (LS-12). It looks where AI histories and notes usually are (Claude
// Code and Codex histories, ChatGPT, Claude and Gemini exports in Downloads, Obsidian vaults and Notes folders: the
// same search as the app's "Bring in"), brings in what isn't in the record yet once you say yes, sums up what came in,
// and names the `skeinwise connect` command for each AI agent it finds.
//
// This file also holds what the CLI wires for setup, connect and doctor: SETUP_COMMANDS, SETUP_FLAGS and SETUP_HELP.
// The three run before the record is opened (doctor must see a missing record as missing), so the CLI calls them
// with a SetupCtx rather than through withStore.

import { connect, type SetupCtx } from './connect.ts';
import { doctor } from './doctor.ts';
import { UsageError } from './errors.ts';
import { openHome } from './home.ts';
import { readImports } from './importers/detect.ts';
import { quoteArg } from './mcp/access.ts';
import { safeLine } from './safe-text.ts';
import { type Found, findAgents, findSources } from './server/found.ts';

export interface Brought {
  label: string;
  path: string;
  /** One line per source the import made (a folder of chats may hold more than one kind). */
  results: { source: string; added: number; versioned: number; unchanged: number; threads: number }[];
  error?: string;
}

/** Where setup looks: SKEINWISE_SCAN_ROOT (tests), else the user's home folder. */
function scanRoot(env: NodeJS.ProcessEnv): string {
  return env.SKEINWISE_SCAN_ROOT || env.HOME || env.USERPROFILE || '';
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `skeinwise setup [--yes] [--json]`. */
export async function setup(ctx: SetupCtx): Promise<number> {
  if (ctx.args.length) throw new UsageError('setup takes no words. To bring in something it doesn\'t find, use: skeinwise import <path>');
  const { io } = ctx;
  const root = scanRoot(io.env);
  if (!root) throw new UsageError("Skeinwise can't tell where your home folder is (HOME isn't set).");
  const say = (t: string) => {
    if (!ctx.values.json) io.out(t);
  };

  const store = openHome(ctx.home, io.now);
  try {
    const found = findSources(root, store.sources());
    const fresh = found.filter((f) => !f.inRecord);
    say(`Your record: ${ctx.home}\n\n`);
    if (!found.length) {
      say(
        'Found no AI histories, exports or note folders in the usual places (Claude Code and Codex histories, ChatGPT, Claude and\n' +
          'Gemini exports in Downloads, Obsidian vaults and Notes folders). Bring in anything else with: skeinwise import <path>\n',
      );
    } else {
      say('Found on this computer:\n');
      for (const f of found) say(`  ${f.label}: ${safeLine(f.detail)}${f.inRecord ? ' (already in your record)' : ''}\n      ${safeLine(f.path)}\n`);
    }

    let go = fresh.length > 0 && Boolean(ctx.values.yes);
    if (fresh.length && !go && !ctx.values.json && io.ask) {
      const answer = await io.ask(`\nBring in ${fresh.length === 1 ? 'it' : `these ${fresh.length}`}? Nothing leaves this computer. (Y/n) `);
      go = answer !== null && /^(y(es)?)?$/i.test(answer.trim());
    }

    const brought: Brought[] = [];
    if (go) {
      say('\n');
      for (const f of fresh) {
        const item = bringIn(store, f);
        brought.push(item);
        if (item.error) say(`  ${f.label}: couldn't bring it in: ${item.error}\n`);
        for (const r of item.results) {
          say(`  ${r.source}: ${r.added} new ${r.added === 1 ? 'entry' : 'entries'}${r.threads ? ` in ${plural(r.threads, 'conversation')}` : ''}${r.versioned ? `, ${r.versioned} changed` : ''}\n`);
        }
      }
      if (fresh.some((f) => f.asksOwner)) {
        say("\nNotes came in as your own words. If a folder holds someone else's, bring it in again with: skeinwise import <path> --owner <name>\n");
      }
    } else if (fresh.length) {
      say('\nBring them in with:\n');
      for (const f of fresh) say(`  skeinwise import ${quoteArg(f.path)}\n`);
      say('or all at once: skeinwise setup --yes\n');
    }

    const agents = findAgents(root).filter((a) => a.found);
    if (agents.length) {
      say('\nGive an AI agent your record as its memory (read only, unless you add --write):\n');
      for (const a of agents) say(`  skeinwise connect ${a.key}`.padEnd(40) + `${a.label}\n`);
    } else {
      say('\nUsing Claude Code, Codex, Cursor or Claude desktop? skeinwise connect <agent> gives it your record as its memory.\n');
    }
    say('Organise what came in: skeinwise run all. Check the setup: skeinwise doctor\n');

    const failed = brought.filter((b) => b.error).length;
    if (ctx.values.json) ctx.json({ home: ctx.home, found, brought, agents: agents.map((a) => a.key) });
    return failed ? 1 : 0;
  } finally {
    store.db.close();
  }
}

function bringIn(store: ReturnType<typeof openHome>, f: Found): Brought {
  const item: Brought = { label: f.label, path: f.path, results: [] };
  try {
    for (const batch of readImports(f.path, {})) {
      const r = store.ingest(batch);
      item.results.push({ source: batch.source.label, added: r.added, versioned: r.versioned, unchanged: r.unchanged, threads: r.threads });
    }
  } catch (err) {
    item.error = safeLine(err instanceof Error ? err.message : String(err)).slice(0, 300);
  }
  return item;
}

export const SETUP_COMMANDS: Record<string, (ctx: SetupCtx) => Promise<number>> = {
  setup,
  connect: (ctx) => connect(ctx),
  doctor: (ctx) => doctor(ctx),
};

/** The flags they read; `yes` and `write` may already be in the CLI's list, with the same meaning. */
export const SETUP_FLAGS = {
  yes: { type: 'boolean' },
  write: { type: 'boolean' },
} as const;

const line = (command: string, text: string) => `  ${command.padEnd(26)}${text}\n`;
const flag = (name: string, text: string) => `      ${name.padEnd(22)}${text}\n`;

export const SETUP_HELP =
  line('setup', 'Find your AI histories and notes, bring them in, name agents to connect') +
  flag('--yes', 'Bring in everything found without asking') +
  line('connect <agent>', 'Give claude-code, codex, cursor or claude-desktop your record as memory') +
  flag('--write', 'Let the agent write notes and tags too') +
  flag('--yes', "Write the agent's config (a copy of the old one is kept)") +
  line('doctor', 'Check Node, the record, live capture, the model server and agent configs');
