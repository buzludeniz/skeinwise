// The e2e test's server: a fresh record of invented exports, organised without a model, served on the port given.
// The record and an empty scan root live in the run folder (SKEINWISE_E2E_RUN, else e2e/.run), so nothing else on this
// computer is read or changed. The record's local model address is a port nothing listens on, so the first run's model
// check never reaches a model server already running here.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { freshRunFolder, runFolder } from './run.ts';

const port = process.argv[2] ?? '7493';
const run = runFolder();
const home = join(run, 'home');
const scan = join(run, 'scan');
freshRunFolder(run);
mkdirSync(home, { recursive: true });
mkdirSync(scan, { recursive: true });

const env = { ...process.env, SKEINWISE_HOME: home, SKEINWISE_SCAN_ROOT: scan };
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
execFileSync(process.execPath, [cli, 'demo'], { env, stdio: 'ignore' });
execFileSync(process.execPath, [cli, 'config', 'localUrl', `http://127.0.0.1:${await closedPort()}/v1`], { env, stdio: 'ignore' });
execFileSync(process.execPath, [cli, 'run', 'all', '--engine', 'none'], { env, stdio: 'ignore' });

const server = spawn(process.execPath, [cli, 'serve', '--port', port], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));

/** A port on 127.0.0.1 that was free a moment ago and is closed now: the system hands one out, and it is let go. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}
