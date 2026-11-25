// The e2e test's server: a fresh record of invented exports, organised without a model, served on the port given.
// The record and an empty scan root live in e2e/.run, so nothing on this computer is read or changed.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const port = process.argv[2] ?? '7493';
const run = join(import.meta.dirname, '.run');
const home = join(run, 'home');
const scan = join(run, 'scan');
rmSync(run, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
mkdirSync(scan, { recursive: true });

const env = { ...process.env, SKEINWISE_HOME: home, SKEINWISE_SCAN_ROOT: scan };
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
execFileSync(process.execPath, [cli, 'demo'], { env, stdio: 'ignore' });
execFileSync(process.execPath, [cli, 'run', 'all', '--engine', 'none'], { env, stdio: 'ignore' });

const server = spawn(process.execPath, [cli, 'serve', '--port', port], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
