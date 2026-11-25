#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ORGANISER_COMMANDS } from './cli-organiser.ts';
import { CONNECTOR_COMMANDS, CONNECTOR_FLAGS, CONNECTOR_HELP } from './connectors/commands.ts';
import { writeDemo } from './demo/demo.ts';
import { needId, UsageError } from './errors.ts';
import { day, entryHeader, indent, minute, speakerLabel } from './format.ts';
import { homeDir, openHome } from './home.ts';
import { readImports } from './importers/detect.ts';
import { readStatus } from './live/capture.ts';
import { describeStatus, startLive } from './live/run.ts';
import { MCP_COMMANDS, MCP_FLAGS, MCP_HELP } from './mcp/commands.ts';
import { MODEL_HELP } from './model-commands.ts';
import { safeIo, safeJson } from './safe-text.ts';
import { serveFromArgs } from './server/serve.ts';
import type { Store } from './store/store.ts';
import { SYNC_COMMANDS, SYNC_FLAGS, SYNC_HELP } from './sync/commands.ts';

/** package.json sits one level up from src/ and two from dist/src/. */
function readPackage(): { version: string } {
  for (const rel of ['../package.json', '../../package.json']) {
    const url = new URL(rel, import.meta.url);
    if (existsSync(url)) return JSON.parse(readFileSync(url, 'utf8')) as { version: string };
  }
  throw new Error('package.json not found');
}

const pkg = readPackage();

const HELP = `skeinwise ${pkg.version}: a second brain that organises itself

Usage: skeinwise <command> [options]

The record lives in $SKEINWISE_HOME, or ~/.skeinwise when that is not set.

Your record:
  init                      Create the record folder
  import <path>...          Import exports, history folders, note folders or zips
      --owner <name>        Whose words a notes folder holds (default: you)
  search <words>...         Full-text search, your own words first
      --limit <n>           Number of results (default 10)
      --speaker <who>       you, assistant or a person's name
      --source <kind>       chatgpt, claude, gemini, claude-code, codex or notes
      --from <date>         Only entries on or after this date (YYYY-MM-DD)
      --to <date>           Only entries on or before this date
  show <entry>              Print one entry
  thread <thread>           Print a whole thread
  history <entry>           List an entry's versions
  stats                     Counts and the busiest months
  sources                   List sources with their status
  exclude <source>          Leave a source out of search and the map
  include <source>          Bring an excluded source back
  not-mine <thread>         Mark a thread as someone else's (--undo to reverse)
  live                      Record live: import new chats and notes as they appear, and
                            organise what is new in the background
      --once                Catch up and organise once, then stop
  demo                      Build a demo record from invented data
      --out <dir>           Where to write the demo export files
      --force               Import even if the record is not empty
  serve                     Open the app in your browser, on this computer only
      --port <n>            Port to listen on (default 7319)
      --open                Open the browser too

Organising (every run can be undone):
  run <task|all>            Run one task, or all in order: tag, file, link, hub, layer, review
      --engine <name>       local (a model server on this computer, the default),
                            remote (one elsewhere) or none (No-AI, nothing leaves this computer)
      --scope <scope>       all (default), new, source:<id> or since:<YYYY-MM-DD>
      --schema <name>       Tag with one schema: Topics, Projects, Moods or one of yours
      --preview             Print what would go to the model; send and save nothing
      --yes                 Go ahead when a model run covers more than 500 entries
  runs                      List runs, newest first (--limit <n>)
  undo <run>                Undo a run or a correction
  ask <question>...         Ask the record: "when did I first ...", "what did I decide about ...",
                            "what changed in my thinking on ...", or anything else
      --engine <name>       As for run; a model's answer cites the entries it rests on
  similar <entry>           Entries in other threads that read like this one
  hubs                      List hubs
  hub <hub>                 Show a hub: In short, What you found, Open ends, its entries
  layers <entry>            An entry's layers: Original, Cleaned, Expanded, Digest, Ideas
      --layer <name>        Only one of them
  tags                      Tags by schema (--schema <name> for one schema in full)
  folders                   Folders and what they hold
  links [<entry>]           Lines between entries: thread line, cross link, note link,
                            hub spoke and time chain
  review                    Notes of yours that later entries may have overtaken
      --resolve <item> <update|holds|skip>
                            Answer one; update shows the change and saves it with --yes

Your notes (Markdown files in the record folder's notes/):
  note <text>...            Add a line to today's daily note
  new-note <title>...       Start a note with a title

Corrections (each is a run you can undo):
  merge-folders <from> <into>  Fold one folder into another
  rename-hub <hub> <name>...   Give a hub a new name
  delete-hub <hub>             Delete a hub

The local model:
${MODEL_HELP}

${SYNC_HELP}
${CONNECTOR_HELP}
Agents (MCP):
${MCP_HELP}
Settings:
  config [<key> [<value>...]]  Show or change a setting (--unset to go back to the default)
  define-tag <schema> <tag> [<words>...]
                            Add a tag to Moods or a schema of your own; the words describe it
      --remove              Remove a tag you defined

  help                      Show this help
  version                   Print the version

Most commands take --json for machine-readable output.
`;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** The network for the model engines; the global fetch when not given. Tests pass a fake. */
  fetch?: typeof fetch;
  /** The clock, as an ISO time; the real one when not given. */
  now?: () => string;
  /** Asks a yes-or-no question and returns the answer, or null when nobody can answer (no terminal). */
  ask?: (question: string) => Promise<string | null>;
}

const defaultIo: Io = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  env: process.env,
  ask: async (question) => {
    if (!process.stdin.isTTY) return null;
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
};

async function withStore<T>(io: Io, fn: (store: Store) => T | Promise<T>): Promise<T> {
  const store = openHome(homeDir(io.env), io.now);
  try {
    return await fn(store);
  } finally {
    store.db.close();
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  const [command = 'help', ...rest] = argv;
  if (command === 'serve') return serveFromArgs(rest, io);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      owner: { type: 'string' },
      limit: { type: 'string' },
      speaker: { type: 'string' },
      source: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      out: { type: 'string' },
      force: { type: 'boolean' },
      undo: { type: 'boolean' },
      once: { type: 'boolean' },
      json: { type: 'boolean' },
      engine: { type: 'string' },
      scope: { type: 'string' },
      schema: { type: 'string' },
      yes: { type: 'boolean' },
      preview: { type: 'boolean' },
      layer: { type: 'string' },
      resolve: { type: 'string' },
      unset: { type: 'boolean' },
      remove: { type: 'boolean' },
      run: { type: 'boolean' },
      ...SYNC_FLAGS,
      ...CONNECTOR_FLAGS,
      ...MCP_FLAGS,
    },
  });
  const json = (v: unknown) => io.out(`${safeJson(v, 2)}\n`);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      io.out(HELP);
      return 0;

    case 'version':
    case '--version':
    case '-v':
      if (values.json) json({ version: pkg.version });
      else io.out(`${pkg.version}\n`);
      return 0;

    case 'init': {
      const home = homeDir(io.env);
      await withStore(io, () => undefined);
      if (values.json) json({ home });
      else io.out(`Record folder ready: ${home}\n`);
      return 0;
    }

    case 'import': {
      if (!positionals.length) throw new UsageError('Give at least one path to import.');
      return withStore(io, (store) => {
        const results = [];
        for (const path of positionals) {
          for (const batch of readImports(path, { owner: values.owner })) {
            const r = store.ingest(batch);
            results.push({ source: batch.source.label, kind: batch.source.kind, ...r });
          }
        }
        if (values.json) json(results);
        else
          for (const r of results) {
            io.out(
              `${r.source}: ${r.added} new, ${r.versioned} changed, ${r.unchanged} already in, ${r.skipped} empty skipped (${r.threads} threads)\n`,
            );
          }
        return 0;
      });
    }

    case 'search': {
      const query = positionals.join(' ').trim();
      if (!query) throw new UsageError('Give some words to search for.');
      const limit = values.limit ? needId(values.limit, 'limit') : 10;
      return withStore(io, (store) => {
        const hits = store.search(query, {
          limit,
          speaker: values.speaker,
          sourceKind: values.source,
          from: values.from,
          to: values.to ? `${values.to}\uffff` : undefined,
        });
        if (values.json) json(hits);
        else if (!hits.length) io.out(`Nothing found for "${query}".\n`);
        else for (const h of hits) io.out(`${entryHeader(h)}\n${indent(h.snippet.replace(/\s+/g, ' '))}\n\n`);
        return 0;
      });
    }

    case 'show': {
      const id = needId(positionals[0], 'entry');
      return withStore(io, (store) => {
        const e = store.getEntry(id);
        if (!e) throw new UsageError(`No entry ${id}.`);
        if (values.json) json(e);
        else io.out(`${entryHeader(e)}${e.version > 1 ? `  (version ${e.version})` : ''}\n\n${e.body}\n`);
        return 0;
      });
    }

    case 'thread': {
      const id = needId(positionals[0], 'thread');
      return withStore(io, (store) => {
        const t = store.getThread(id);
        if (!t) throw new UsageError(`No thread ${id}.`);
        const entries = store.threadEntries(id);
        if (values.json) json({ ...t, entries });
        else {
          io.out(`${t.title}\n${day(t.startedAt)} · ${t.entries} entries${t.notMine ? ' · not mine' : ''}\n\n`);
          for (const e of entries) io.out(`${speakerLabel(e)} (#${e.id}, ${minute(e.createdAt)}):\n${indent(e.body)}\n\n`);
        }
        return 0;
      });
    }

    case 'history': {
      const id = needId(positionals[0], 'entry');
      return withStore(io, (store) => {
        if (!store.getEntry(id)) throw new UsageError(`No entry ${id}.`);
        const versions = store.history(id);
        if (values.json) json(versions);
        else
          for (const v of versions) {
            io.out(`v${v.version}  ${minute(v.editedAt)}  by ${v.editor}  ${v.contentHash.slice(0, 12)}\n`);
          }
        return 0;
      });
    }

    case 'live': {
      const home = homeDir(io.env);
      const store = openHome(home, io.now);
      let started = false; // the catch-up pass is printed below, so only later passes print here
      const live = startLive(store, home, {
        once: values.once === true,
        userHome: io.env.HOME || homedir(),
        fetch: io.fetch ?? fetch,
        env: io.env,
        onSaved: (status) => started && io.out(describeStatus(status)),
        onOrganised: (status) => started && !values.json && io.out(describeStatus(status)),
        progress: (line) => io.err(`${line}\n`),
        onPulled: (lines) => !values.json && io.out(lines.map((l) => `${l}\n`).join('')),
      });
      if (values.once) {
        // Wait for the organiser, then report capture and organising together.
        await live.pulled; // a pull that brought something starts a pass, which idle() then waits for
        await live.background?.idle();
        const status = readStatus(join(home, 'live.json'));
        store.db.close();
        if (values.json) json(status);
        else io.out(describeStatus(status));
        return status.errors.length || status.organised?.error ? 1 : 0;
      }
      started = true;
      if (values.json) json(live.first);
      else io.out(describeStatus(live.first));
      io.out('Recording live. Press Ctrl+C to stop.\n');
      process.once('SIGINT', () => {
        live.stop();
        store.db.close();
        process.exit(0);
      });
      return 0;
    }

    case 'stats':
      return withStore(io, (store) => {
        const s = store.stats();
        if (values.json) {
          json(s);
          return 0;
        }
        io.out(`Woven from ${s.entries} entries in ${s.threads} threads from ${s.sources} sources.\n`);
        io.out(`Your own words: ${s.yours} entries.\n`);
        if (s.first && s.last) io.out(`From ${day(s.first)} to ${day(s.last)}.\n`);
        const busiest = [...s.byMonth].sort((a, b) => b.entries - a.entries).slice(0, 5);
        if (busiest.length) {
          io.out('\nBusiest months:\n');
          const max = busiest[0]!.entries;
          for (const m of busiest) io.out(`  ${m.month}  ${'█'.repeat(Math.max(1, Math.round((m.entries / max) * 24)))} ${m.entries}\n`);
        }
        return 0;
      });

    case 'sources':
      return withStore(io, (store) => {
        const list = store.sources();
        if (values.json) json(list);
        else if (!list.length) io.out('No sources yet. Try: skeinwise import <path>\n');
        else
          for (const s of list) {
            const owner = s.owner === 'you' ? '' : `, words of ${s.owner}`;
            io.out(`${String(s.id).padStart(3)}  ${s.status.padEnd(5)} ${s.label} (${s.kind}${owner}): ${s.entries} entries${s.location ? `  ${s.location}` : ''}\n`);
          }
        return 0;
      });

    case 'exclude':
    case 'include': {
      const id = needId(positionals[0], 'source');
      return withStore(io, (store) => {
        store.setSourceStatus(id, command === 'exclude' ? 'out' : 'in');
        if (values.json) json({ source: id, status: command === 'exclude' ? 'out' : 'in' });
        else io.out(command === 'exclude' ? `Source ${id} left out.\n` : `Source ${id} brought back in.\n`);
        return 0;
      });
    }

    case 'not-mine': {
      const id = needId(positionals[0], 'thread');
      return withStore(io, (store) => {
        store.setNotMine(id, !values.undo);
        if (values.json) json({ thread: id, notMine: !values.undo });
        else io.out(values.undo ? `Thread ${id} is yours again.\n` : `Thread ${id} marked not mine; it stays in history.\n`);
        return 0;
      });
    }

    case 'demo': {
      const home = homeDir(io.env);
      const out = resolve(values.out ?? join(home, 'demo-exports'));
      return withStore(io, (store) => {
        if (store.stats().entries > 0 && !values.force) {
          throw new UsageError(
            `The record in ${home} is not empty. Run the demo in its own folder, for example:\n  SKEINWISE_HOME=~/skeinwise-demo skeinwise demo\nor pass --force to add it anyway.`,
          );
        }
        const summary = writeDemo(out);
        const results = [];
        for (const part of ['chatgpt', 'claude', 'claude-code', 'notes']) {
          for (const batch of readImports(join(out, part))) results.push({ source: batch.source.label, ...store.ingest(batch) });
        }
        if (values.json) json({ ...summary, files: summary.files.length, results });
        else {
          io.out(`Wrote invented exports to ${out}: ${summary.threads} chats, ${summary.notes} notes.\n`);
          for (const r of results) io.out(`  ${r.source}: ${r.added} entries\n`);
          io.out(`\nTry: skeinwise search "what did I decide about sqlite"\n`);
          io.out(`Organise it without a model: skeinwise run all --engine none\n`);
        }
        return 0;
      });
    }

    default: {
      const organiser = ORGANISER_COMMANDS[command] ?? SYNC_COMMANDS[command] ?? CONNECTOR_COMMANDS[command] ?? MCP_COMMANDS[command];
      if (!organiser) throw new UsageError(`Unknown command: ${command}. Run "skeinwise help" for the list.`);
      const home = homeDir(io.env);
      return withStore(io, (store) => organiser({ io, home, store, values, args: positionals, json }));
    }
  }
}

/** Runs one command. Returns the exit code; never throws. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  // Everything a command prints goes through these two printers, so imported text can't send the terminal escape
  // sequences or bidi overrides (LS-07).
  const safe = safeIo(io);
  try {
    return await run(argv, safe);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    safe.err(`skeinwise: ${message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
