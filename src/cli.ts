#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writeDemo } from './demo/demo.ts';
import { homeDir, openHome } from './home.ts';
import { readImports } from './importers/detect.ts';
import type { Entry, Store } from './store/store.ts';

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

Commands:
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
  demo                      Build a demo record from invented data
      --out <dir>           Where to write the demo export files
      --force               Import even if the record is not empty
  help                      Show this help
  version                   Print the version

Most commands take --json for machine-readable output.
`;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

const defaultIo: Io = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  env: process.env,
};

class UsageError extends Error {}

function needId(value: string | undefined, what: string): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n < 1) throw new UsageError(`Give a ${what} number, for example: 12`);
  return n;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function speakerLabel(e: Entry): string {
  return e.speaker === 'assistant' ? `${e.sourceLabel}` : e.speaker;
}

function entryHeader(e: Entry): string {
  const where = e.threadTitle ? ` · ${e.threadTitle}` : e.title ? ` · ${e.title}` : '';
  return `#${e.id}  ${day(e.createdAt)}  ${speakerLabel(e)} · ${e.sourceLabel}${where}`;
}

function indent(text: string, pad = '    '): string {
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n');
}

function withStore<T>(io: Io, fn: (store: Store) => T): T {
  const store = openHome(homeDir(io.env));
  try {
    return fn(store);
  } finally {
    store.db.close();
  }
}

function run(argv: string[], io: Io): number {
  const [command = 'help', ...rest] = argv;
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
      json: { type: 'boolean' },
    },
  });
  const json = (v: unknown) => io.out(`${JSON.stringify(v, null, 2)}\n`);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      io.out(HELP);
      return 0;

    case 'version':
    case '--version':
    case '-v':
      io.out(`${pkg.version}\n`);
      return 0;

    case 'init': {
      const home = homeDir(io.env);
      withStore(io, () => undefined);
      io.out(`Record folder ready: ${home}\n`);
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
          to: values.to ? `${values.to}￿` : undefined,
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
          for (const e of entries) io.out(`${speakerLabel(e)} (#${e.id}, ${e.createdAt.slice(0, 16).replace('T', ' ')}):\n${indent(e.body)}\n\n`);
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
            io.out(`v${v.version}  ${v.editedAt.slice(0, 16).replace('T', ' ')}  by ${v.editor}  ${v.contentHash.slice(0, 12)}\n`);
          }
        return 0;
      });
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
        io.out(command === 'exclude' ? `Source ${id} left out.\n` : `Source ${id} brought back in.\n`);
        return 0;
      });
    }

    case 'not-mine': {
      const id = needId(positionals[0], 'thread');
      return withStore(io, (store) => {
        store.setNotMine(id, !values.undo);
        io.out(values.undo ? `Thread ${id} is yours again.\n` : `Thread ${id} marked not mine; it stays in history.\n`);
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
        }
        return 0;
      });
    }

    default:
      throw new UsageError(`Unknown command: ${command}. Run "skeinwise help" for the list.`);
  }
}

/** Runs one command. Returns the exit code; never throws. */
export function main(argv: string[], io: Io = defaultIo): number {
  try {
    return run(argv, io);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`skeinwise: ${message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
