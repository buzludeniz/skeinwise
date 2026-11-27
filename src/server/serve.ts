// `skeinwise serve`: runs the app on this computer at 127.0.0.1 and prints the address with its token.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { homeDir, openHome } from '../home.ts';
import type { Store } from '../store/store.ts';
import { createHandler } from './app.ts';
import { readConfig } from './config.ts';
import { AppLive } from './live.ts';
import { loadToken, newToken } from './token.ts';
import { cleanUploads } from './uploads.ts';

export const DEFAULT_PORT = 7319;

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

function version(): string {
  for (const rel of ['../../package.json', '../../../package.json']) {
    const url = new URL(rel, import.meta.url);
    if (existsSync(url)) return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
  }
  return '0.0.0';
}

/** The built page: dist/web next to the source tree or the compiled one. */
export function findWebDir(): string | null {
  for (const rel of ['../../dist/web', '../../web']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

export interface Running {
  server: Server;
  store: Store;
  port: number;
  token: string;
  /** The address to open, with the token in the fragment (fragments never reach the server's logs). */
  url: string;
  close: () => Promise<void>;
}

export interface StartOptions {
  home: string;
  /** 0 picks a free port. */
  port?: number;
  /** When the port is taken, try the next few. */
  tryNext?: boolean;
  webDir?: string | null;
  scanRoot?: string;
  onQuit?: () => void;
  /** Keep the token from the last run, so an open page or bookmark still works. By default each start makes a new one. */
  keepToken?: boolean;
  /** The upload cap in bytes (tests set a small one); 1 GB otherwise. */
  uploadLimit?: number;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startServer(options: StartOptions): Promise<Running> {
  const store = openHome(options.home);
  const token = options.keepToken ? loadToken(options.home) : newToken(options.home);
  cleanUploads(options.home);
  const scanRoot = options.scanRoot ?? homedir();
  const live = new AppLive(store, options.home, { userHome: scanRoot });
  let port = 0;
  let running: Running | undefined;
  const server = createServer(
    createHandler({
      home: options.home,
      store,
      token,
      webDir: options.webDir === undefined ? findWebDir() : options.webDir,
      version: version(),
      scanRoot,
      live,
      uploadLimit: options.uploadLimit,
      port: () => port,
      onQuit: () => {
        void running?.close().then(() => options.onQuit?.());
      },
    }),
  );
  server.keepAliveTimeout = 5000;
  const first = options.port ?? DEFAULT_PORT;
  const tries = options.tryNext && first !== 0 ? 10 : 1;
  for (let i = 0; i < tries; i++) {
    try {
      port = await listen(server, first + i);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || i === tries - 1) {
        store.db.close();
        throw code === 'EADDRINUSE' ? new Error(`Port ${first + i} is in use. Pick another with --port.`) : error;
      }
    }
  }
  // Live capture picks up where the app left it. A settings file that can't be read keeps it off; GET /api/settings
  // reports that file's error to the page.
  let recordLive = false;
  try {
    recordLive = readConfig(options.home).recordLive;
  } catch {
    recordLive = false;
  }
  live.set(recordLive);
  let closed = false;
  running = {
    server,
    store,
    port,
    token,
    url: `http://127.0.0.1:${port}/#token=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        live.stop();
        server.close(() => {
          store.db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
  return running;
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}

/** Runs `skeinwise serve [--port <n>] [--open] [--keep-token]`. Returns at once; the server keeps the process alive. */
export function serveFromArgs(argv: string[], io: Io): number {
  const { values } = parseArgs({
    args: argv,
    options: { port: { type: 'string' }, open: { type: 'boolean' }, 'keep-token': { type: 'boolean' } },
  });
  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Give a port number, for example: --port 7319');
  }
  const home = homeDir(io.env);
  startServer({
    home,
    port,
    tryNext: values.port === undefined,
    scanRoot: io.env.SKEINWISE_SCAN_ROOT || homedir(),
    keepToken: values['keep-token'] === true,
  }).then(
    (running) => {
      io.out(`Skeinwise is running on this computer only.\nOpen: ${running.url}\nRecord: ${home}\nPress Ctrl+C to stop.\n`);
      if (values.open) openBrowser(running.url);
      const stop = () => {
        void running.close().then(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    },
    (error: unknown) => {
      io.err(`skeinwise: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
  return 0;
}
