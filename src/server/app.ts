// The app's HTTP handler: a JSON API over the record, and the built page. Every API call needs the per-install token
// in the X-Skeinwise-Token header; requests must name this server's own host, so pages from other sites can't reach it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { UsageError } from '../errors.ts';
import { readImports } from '../importers/detect.ts';
import { deleteHub, mergeFolders, REVIEW_ACTIONS, type ReviewAction, renameHub, resolveReview } from '../organiser/corrections.ts';
import type { ModelDeps } from '../organiser/model.ts';
import { undoRun } from '../organiser/runs.ts';
import type { Store } from '../store/store.ts';
import { backup } from './backup.ts';
import { cellEntries, parseFilter, tableCounts, type TableProp, tides, timelineBuckets } from './buckets.ts';
import { ConfigError, readConfig, TABLE_PROPS, writeConfig } from './config.ts';
import { findAgents, findSources, preview } from './found.ts';
import type { AppLive } from './live.ts';
import { appendDaily, createNote, NoteError, noteTitles, ownFile, saveEntry } from './notes.ts';
import {
  askQuestion,
  entryLines,
  entryOrganised,
  hubDetail,
  lineCounts,
  type OrganiseJob,
  organiserState,
  previewOrganise,
  startOrganise,
} from './organiser.ts';
import {
  aboutYou,
  brainData,
  brief,
  entryDetail,
  entryRows,
  isQuestion,
  lastSaved,
  numbers,
  organiserReady,
} from './queries.ts';
import { sameToken } from './token.ts';
import { BATCH_ID, CutOff, saveUpload, TooLarge, UPLOAD_LIMIT } from './uploads.ts';

export interface AppContext {
  home: string;
  store: Store;
  token: string;
  /** The built page (dist/web), or null when it hasn't been built. */
  webDir: string | null;
  version: string;
  /** Where to look for sources and agents: the home directory unless SKEINWISE_SCAN_ROOT says otherwise. */
  scanRoot: string;
  /** Record live: the update stream, run in this server while the app menu's switch is on. */
  live: AppLive;
  /** The port the server listens on, for the Host check. */
  port: () => number;
  onQuit?: () => void;
  /** For the model engines: the environment that holds an outside key, and the network. Tests pass fakes. */
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  /** The most one uploaded file may hold, in bytes: 1 GB unless a test sets less. */
  uploadLimit?: number;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Req {
  method: string;
  url: URL;
  params: string[];
  raw: IncomingMessage;
  json: () => Promise<Record<string, unknown>>;
}

type Handler = (req: Req) => unknown;

const JSON_LIMIT = 2 * 1024 * 1024;

async function readJson(raw: IncomingMessage): Promise<Record<string, unknown>> {
  const type = raw.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Send JSON');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of raw) {
    size += (chunk as Buffer).length;
    if (size > JSON_LIMIT) throw new HttpError(413, 'Too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'The body is not a JSON object');
  }
}

function id(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Not an id');
  return n;
}

function text(value: unknown, what: string, max = 100_000): string {
  if (typeof value !== 'string') throw new HttpError(400, `${what} must be text`);
  if (value.length > max) throw new HttpError(413, `${what} is too long`);
  return value;
}

function prop(value: string | null, fallback: TableProp): TableProp {
  if (!value) return fallback;
  if (!(TABLE_PROPS as readonly string[]).includes(value)) throw new HttpError(400, `Unknown property: ${value}`);
  return value as TableProp;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Skeinwise</title>
<body style="font:15px system-ui;background:#0f1219;color:#e9e4d8;padding:40px">
<p>The app isn't built yet. Run <code>pnpm build</code>, then start <code>skeinwise serve</code> again.</p>`;

export function createHandler(ctx: AppContext): (req: IncomingMessage, res: ServerResponse) => void {
  const { store, home } = ctx;
  let locked = false;
  const uploads = resolve(home, 'imports');
  const deps = (): ModelDeps => ({ fetch: ctx.fetch ?? fetch, env: ctx.env ?? process.env });
  /**
   * A path the page sent, when its real path lies under the scan root (M2). Anything else, missing, unreadable or
   * elsewhere (a symlink out included), gets the same 403, so the answer says nothing about the rest of the computer.
   * Files from elsewhere come in through an upload. The path goes on as sent, since /api/found matches sources by it.
   */
  const scanned = (path: string): string => {
    try {
      const root = realpathSync(ctx.scanRoot);
      const real = isAbsolute(path) ? realpathSync(path) : '';
      if (real === root || real.startsWith(root + sep)) return resolve(path);
    } catch {
      // Missing or unreadable: the same answer as outside.
    }
    throw new HttpError(403, OUTSIDE_SCAN);
  };
  /** The run the page started last; the page follows it until it finishes. */
  let job: OrganiseJob | null = null;

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/status$/, () => ({
      version: ctx.version,
      locked,
      entries: store.stats().entries,
      lastSaved: lastSaved(store.db),
      organiser: organiserReady(store.db),
      live: ctx.live.state(),
    })],
    ['POST', /^\/api\/lock$/, () => {
      locked = true;
      return { locked };
    }],
    ['POST', /^\/api\/unlock$/, () => {
      locked = false;
      return { locked };
    }],
    ['POST', /^\/api\/quit$/, () => {
      setTimeout(() => ctx.onQuit?.(), 50);
      return { stopping: true };
    }],

    ['GET', /^\/api\/settings$/, () => readConfig(home)],
    ['PUT', /^\/api\/settings$/, async (req) => {
      const saved = writeConfig(home, await req.json());
      ctx.live.set(saved.recordLive);
      return saved;
    }],

    ['GET', /^\/api\/stats$/, () => numbers(store)],
    ['GET', /^\/api\/sources$/, () => store.sources()],
    ['POST', /^\/api\/sources\/(\d+)$/, async (req) => {
      const { status } = await req.json();
      if (status !== 'in' && status !== 'out' && status !== 'later') throw new HttpError(400, 'status is in, out or later');
      store.setSourceStatus(id(req.params[0]), status);
      return store.sources();
    }],

    ['GET', /^\/api\/brain$/, () => brainData(store.db)],

    ['GET', /^\/api\/entries\/(\d+)$/, (req) => {
      const detail = entryDetail(store, id(req.params[0]));
      if (!detail) throw new HttpError(404, 'No such entry');
      return { ...detail, ownFile: ownFile(home, store, detail.entry.id) !== null, ...entryOrganised(store.db, detail.entry.id) };
    }],
    ['PUT', /^\/api\/entries\/(\d+)$/, async (req) => {
      const { body } = await req.json();
      return saveEntry(home, store, id(req.params[0]), text(body, 'body'));
    }],

    ['GET', /^\/api\/threads\/(\d+)$/, (req) => {
      const t = store.getThread(id(req.params[0]));
      if (!t) throw new HttpError(404, 'No such thread');
      return { thread: t, entries: store.threadEntries(t.id) };
    }],
    ['POST', /^\/api\/threads\/(\d+)\/not-mine$/, async (req) => {
      const { notMine } = await req.json();
      if (typeof notMine !== 'boolean') throw new HttpError(400, 'notMine must be true or false');
      store.setNotMine(id(req.params[0]), notMine);
      return store.getThread(id(req.params[0]));
    }],

    ['GET', /^\/api\/search$/, (req) => {
      const q = req.url.searchParams.get('q')?.trim() ?? '';
      const limit = Math.min(1000, Math.max(1, Number(req.url.searchParams.get('limit') ?? 20) || 20));
      if (!q) return { query: q, question: false, hits: [] };
      const p = req.url.searchParams;
      const to = p.get('to');
      const hits = store.search(q, {
        limit,
        speaker: p.get('speaker') ?? undefined,
        sourceKind: p.get('source') ?? undefined,
        from: p.get('from') ?? undefined,
        to: to ? `${to}￿` : undefined,
      });
      return { query: q, question: isQuestion(q), hits: hits.map((h) => ({ ...brief(h), snippet: h.snippet, threadId: h.threadId })) };
    }],
    ['GET', /^\/api\/ask$/, (req) => {
      const q = req.url.searchParams.get('q')?.trim() ?? '';
      if (!q) throw new HttpError(400, 'Ask a question');
      if (q.length > 2000) throw new HttpError(413, 'The question is too long');
      return askQuestion(store, home, q, req.url.searchParams.get('engine') ?? undefined, deps());
    }],
    ['GET', /^\/api\/claim$/, (req) => {
      const q = req.url.searchParams.get('q')?.trim() ?? '';
      if (!q) throw new HttpError(400, 'Give a sentence to check');
      return { claim: q, entries: store.search(q, { limit: 12 }).map((h) => ({ ...brief(h), snippet: h.snippet })) };
    }],

    ['GET', /^\/api\/timeline$/, (req) => {
      const by = req.url.searchParams.get('by') === 'speaker' ? 'speaker' : 'source';
      return timelineBuckets(entryRows(store.db), by);
    }],
    ['GET', /^\/api\/table$/, (req) => {
      const p = req.url.searchParams;
      return tableCounts(entryRows(store.db), prop(p.get('x'), 'time'), prop(p.get('y'), 'source'), parseFilter(p.get('filter')));
    }],
    ['GET', /^\/api\/table\/cell$/, (req) => {
      const p = req.url.searchParams;
      const rows = cellEntries(
        entryRows(store.db),
        prop(p.get('x'), 'time'),
        p.get('xv') ?? '',
        prop(p.get('y'), 'source'),
        p.get('yv') ?? '',
        parseFilter(p.get('filter')),
      );
      return { total: rows.length, entries: rows.slice(0, 200) };
    }],
    ['GET', /^\/api\/tides$/, (req) => {
      const by = req.url.searchParams.get('by');
      return tides(entryRows(store.db), by === 'speaker' || by === 'folder' ? by : 'source');
    }],
    ['GET', /^\/api\/you$/, () => aboutYou(store)],

    ['GET', /^\/api\/notes$/, () => noteTitles(store)],
    ['POST', /^\/api\/notes$/, async (req) => {
      const { title, body } = await req.json();
      return { id: createNote(home, store, text(title, 'title', 300), body === undefined ? '' : text(body, 'body')) };
    }],
    ['POST', /^\/api\/daily$/, async (req) => {
      const { text: line } = await req.json();
      return { id: appendDaily(home, store, text(line, 'text', 5000)) };
    }],

    ['GET', /^\/api\/found$/, () => {
      const decisions = readConfig(home).bringIn;
      return findSources(ctx.scanRoot, store.sources()).map((f) => ({ ...f, decision: decisions[f.path] ?? null }));
    }],
    ['POST', /^\/api\/found\/preview$/, async (req) => {
      const { path } = await req.json();
      const where = scanned(text(path, 'path', 4096));
      try {
        return preview(where);
      } catch (error) {
        throw new HttpError(422, error instanceof Error ? error.message : String(error));
      }
    }],
    ['POST', /^\/api\/import$/, async (req) => {
      const { path, owner } = await req.json();
      return importPath(store, scanned(text(path, 'path', 4096)), owner);
    }],
    ['POST', /^\/api\/upload$/, async (req) => {
      const batch = req.url.searchParams.get('batch') ?? '';
      const rel = req.url.searchParams.get('path') ?? '';
      if (!BATCH_ID.test(batch)) throw new HttpError(400, 'Bad batch id');
      const dir = join(uploads, batch);
      const file = resolve(dir, normalize(rel).replace(/^(\.\.(\/|\\|$))+/, ''));
      if (!rel || !file.startsWith(dir + sep)) throw new HttpError(400, 'Bad file path');
      mkdirSync(resolve(file, '..'), { recursive: true, mode: 0o700 });
      try {
        await saveUpload(req.raw, file, ctx.uploadLimit ?? UPLOAD_LIMIT);
      } catch (error) {
        throw error instanceof TooLarge ? new HttpError(413, error.message) : error instanceof CutOff ? new HttpError(400, error.message) : error;
      }
      return { saved: rel };
    }],
    ['POST', /^\/api\/upload\/finish$/, async (req) => {
      const { batch, owner } = await req.json();
      if (typeof batch !== 'string' || !BATCH_ID.test(batch)) throw new HttpError(400, 'Bad batch id');
      const dir = join(uploads, batch);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new HttpError(404, 'Nothing was uploaded');
      // Each zip and each folder at the top is imported on its own, so a folder keeps its name as the source's.
      // The page puts loose files in a folder of their own.
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || (e.isFile() && e.name.toLowerCase().endsWith('.zip')))
        .flatMap((e) => importPath(store, join(dir, e.name), owner));
    }],
    ['GET', /^\/api\/agents$/, () => findAgents(ctx.scanRoot)],

    ['GET', /^\/api\/model\/test$/, async () => {
      const { ai } = readConfig(home);
      const address = ai.local.address.replace(/\/+$/, '');
      let host: string;
      try {
        host = new URL(address).hostname;
      } catch {
        return { ok: false, message: `${address} is not an address` };
      }
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
        return { ok: false, message: 'The local model must be on this computer (127.0.0.1 or localhost)' };
      }
      try {
        const res = await fetch(`${address}/models`, { signal: AbortSignal.timeout(2500) });
        if (!res.ok) return { ok: false, message: `The server answered ${res.status}` };
        const data = (await res.json()) as { data?: { id?: string }[] };
        const models = (data.data ?? []).map((m) => m.id).filter(Boolean);
        return { ok: true, message: models.length ? `Running: ${models.join(', ')}` : 'The server is running' };
      } catch {
        return { ok: false, message: `Nothing answered at ${address}. Start llama-server or Ollama, then test again.` };
      }
    }],
    ['POST', /^\/api\/backup$/, () => backup(home, store.db)],

    // The organiser: what its runs made, your corrections, and runs started from here.
    ['GET', /^\/api\/organiser$/, () => organiserState(store.db)],
    ['GET', /^\/api\/hubs\/(\d+)$/, (req) => {
      const found = hubDetail(store, id(req.params[0]));
      if (!found) throw new HttpError(404, 'No such hub');
      return found;
    }],
    ['POST', /^\/api\/hubs\/(\d+)\/rename$/, async (req) => {
      const { name } = await req.json();
      return renameHub(store, id(req.params[0]), text(name, 'name', 200));
    }],
    ['POST', /^\/api\/hubs\/(\d+)\/delete$/, (req) => deleteHub(store, id(req.params[0]))],
    ['POST', /^\/api\/review\/(\d+)$/, async (req) => {
      const { action, yes } = await req.json();
      if (!(REVIEW_ACTIONS as readonly unknown[]).includes(action)) throw new HttpError(400, `action is ${REVIEW_ACTIONS.join(', ')}`);
      return resolveReview(store, home, id(req.params[0]), action as ReviewAction, yes === true);
    }],
    ['POST', /^\/api\/runs\/(\d+)\/undo$/, (req) => undoRun(store.db, id(req.params[0]))],
    ['POST', /^\/api\/folders\/merge$/, async (req) => {
      const { from, into } = await req.json();
      const ref = (v: unknown, what: string) => (typeof v === 'number' ? String(v) : text(v, what, 300));
      return mergeFolders(store, ref(from, 'from'), ref(into, 'into'));
    }],
    ['GET', /^\/api\/organise$/, () => ({ job })],
    ['POST', /^\/api\/organise\/preview$/, async (req) => previewOrganise(store, home, await req.json(), deps())],
    ['POST', /^\/api\/organise$/, async (req) => {
      if (job && !job.finished) throw new HttpError(409, 'A run is already going. Wait for it to finish.');
      const started = startOrganise(store, home, await req.json(), deps());
      job = started.job;
      // A small run finishes here and answers at once; a model run answers while it works, and the page follows it.
      await Promise.race([started.done, new Promise((r) => setTimeout(r, 1500))]);
      return { job };
    }],
    ['GET', /^\/api\/links$/, () => lineCounts(store)],
    ['GET', /^\/api\/links\/(\d+)$/, (req) => entryLines(store, id(req.params[0]))],
  ];

  const allowedHosts = () => {
    const port = ctx.port();
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  };

  const send = (raw: IncomingMessage, res: ServerResponse, status: number, value: unknown) => {
    let body: Buffer = Buffer.from(JSON.stringify(value));
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    if (body.length > 16_384 && /\bgzip\b/.test(String(raw.headers['accept-encoding'] ?? ''))) {
      body = gzipSync(body);
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = String(body.length);
    res.writeHead(status, headers).end(body);
  };

  const serveStatic = (url: URL, res: ServerResponse) => {
    if (!ctx.webDir) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...PAGE_HEADERS }).end(NOT_BUILT);
      return;
    }
    const root = ctx.webDir;
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = resolve(root, `.${path}`);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(404).end();
      return;
    }
    const isFile = existsSync(file) && statSync(file).isFile();
    if (!isFile) {
      // Unknown paths get the page, so links like /?view=lab work; unknown files under assets/ are a 404.
      if (path.startsWith('/assets/')) {
        res.writeHead(404).end();
        return;
      }
      file = join(root, 'index.html');
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const immutable = file.includes(`${sep}assets${sep}`);
    res
      .writeHead(200, {
        'Content-Type': type,
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...PAGE_HEADERS,
      })
      .end(readFileSync(file));
  };

  const handle = async (raw: IncomingMessage, res: ServerResponse) => {
    const host = raw.headers.host ?? '';
    if (!allowedHosts().has(host)) {
      res.writeHead(421, { 'Content-Type': 'text/plain' }).end('Skeinwise only answers on 127.0.0.1');
      return;
    }
    // A request line Node accepts can still be no URL at all ("GET http://[", M3): that is the client's mistake.
    let url: URL;
    try {
      url = new URL(raw.url ?? '/', `http://${host}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      if (raw.method !== 'GET' && raw.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      serveStatic(url, res);
      return;
    }
    try {
      const origin = raw.headers.origin;
      if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) throw new HttpError(403, 'Wrong origin');
      const given = raw.headers['x-skeinwise-token'];
      if (!sameToken(Array.isArray(given) ? given[0] : given, ctx.token)) throw new HttpError(401, 'Missing or wrong token');
      const method = raw.method ?? 'GET';
      let pathMatched = false;
      for (const [m, re, handler] of routes) {
        const match = re.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (m !== method) continue;
        if (locked && !/^\/api\/(status|unlock|quit)$/.test(url.pathname)) throw new HttpError(423, 'Skeinwise is locked');
        let body: Promise<Record<string, unknown>> | undefined;
        const req: Req = { method, url, params: match.slice(1), raw, json: () => (body ??= readJson(raw)) };
        send(raw, res, 200, await handler(req));
        return;
      }
      throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'No such API');
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof ConfigError || error instanceof NoteError || error instanceof UsageError
            ? 400
            : /^No (entry|source|thread) \d+/.test(error instanceof Error ? error.message : '')
              ? 404
              : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status === 500) process.stderr.write(`skeinwise serve: ${error instanceof Error ? (error.stack ?? message) : message}\n`);
      // The page gets no paths outside the record folder (M2, L10); the terminal keeps the whole message.
      if (!res.headersSent) send(raw, res, status, { error: publicMessage(message, home) });
      else res.end();
    }
  };

  return (raw, res) => {
    handle(raw, res).catch((error: unknown) => {
      // Nothing a request does may stop the server: the last word is a bare 500.
      process.stderr.write(`skeinwise serve: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Internal error');
      else res.destroy();
    });
  };
}

const OUTSIDE_SCAN = 'Skeinwise brings in only what it found for you. To add something else, upload it.';

/** Absolute paths in a message: POSIX ones and Windows drive paths, each starting a word or a quoted part. */
const ABSOLUTE_PATH = /(?<=^|[\s'"`(=])(?:\/|[A-Za-z]:\\)[^\s'"`),;]*/g;

/**
 * A message as the page may see it: any absolute path outside the record folder becomes its last part, so an error
 * can't tell a token holder what exists elsewhere on this computer.
 */
export function publicMessage(message: string, home: string): string {
  const root = resolve(home);
  return message.replace(ABSOLUTE_PATH, (path) => {
    const clean = path.replace(/[.:]+$/, '');
    const rest = path.slice(clean.length);
    if (clean === root || clean.startsWith(root + sep)) return path;
    const name = clean.split(/[\\/]/).filter(Boolean).at(-1);
    return `${name ? `…/${name}` : '…'}${rest}`;
  });
}

function importPath(store: Store, path: string, owner: unknown): { source: string; kind: string; added: number; versioned: number; unchanged: number; threads: number }[] {
  const who = typeof owner === 'string' && owner.trim() && owner.trim().toLowerCase() !== 'you' ? owner.trim().slice(0, 100) : undefined;
  let batches;
  try {
    batches = readImports(path, { owner: who });
  } catch (error) {
    throw new HttpError(422, error instanceof Error ? error.message : String(error));
  }
  return batches.map((batch) => {
    const r = store.ingest(batch);
    return { source: batch.source.label, kind: batch.source.kind, added: r.added, versioned: r.versioned, unchanged: r.unchanged, threads: r.threads };
  });
}
