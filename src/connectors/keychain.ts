// Where tokens live: the macOS Keychain, through the `security` command. A secret never goes on a command line (where
// `ps` would show it), on disk, in config.json or in a log: it is written through `security -i` on standard input and
// read back from standard output. Everything else talks to the `Keychain` interface, which tests replace with a fake.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ServiceName } from './types.ts';

export interface Keychain {
  /** The secret, or null when there is none. */
  get(item: string): Promise<string | null>;
  set(item: string, secret: string): Promise<void>;
  /** Whether there was one to delete. */
  delete(item: string): Promise<boolean>;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command with optional standard input. Tests pass a fake, so the real `security` never runs there. */
export type Runner = (command: string, args: string[], input?: string) => Promise<RunResult>;

const SECURITY = '/usr/bin/security';
/** The Keychain's "service" for every Skeinwise item; the item name goes in its "account". */
const KEYCHAIN_SERVICE = 'skeinwise';
/** `security` exits with this when the item isn't there. */
const NOT_FOUND = 44;

export const runProcess: Runner = (command, args, input) =>
  new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', fail);
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input ?? '');
  });

/**
 * The item names for one record folder, so a demo record and your real one never share a token:
 * `<12 hex of the folder's path>/<service>/token` and `.../client-secret`.
 */
export function keychainItems(home: string, service: ServiceName): { token: string; clientSecret: string } {
  const id = createHash('sha256').update(resolve(home)).digest('hex').slice(0, 12);
  return { token: `${id}/${service}/token`, clientSecret: `${id}/${service}/client-secret` };
}

/** Item names reach `security -i` as words, so they may hold only these characters. */
const SAFE_WORD = /^[A-Za-z0-9._/-]+$/;

export function macKeychain(run: Runner = runProcess): Keychain {
  const check = (item: string) => {
    if (!SAFE_WORD.test(item)) throw new Error(`Not a usable Keychain item name: ${item}`);
  };
  return {
    async get(item) {
      check(item);
      const r = await run(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', item, '-w']);
      if (r.code === NOT_FOUND) return null;
      if (r.code !== 0) throw new Error(`The Keychain refused to read ${item}: ${r.stderr.trim() || `exit ${r.code}`}`);
      // Stored as base64, so any text survives the trip through a command line reader.
      return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
    },
    async set(item, secret) {
      check(item);
      const encoded = Buffer.from(secret, 'utf8').toString('base64');
      // -U replaces an item already there. The line goes on standard input, never in the arguments.
      const line = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${item} -w ${encoded}\n`;
      const r = await run(SECURITY, ['-i'], line);
      if (r.code !== 0 || /error|fail/i.test(r.stderr)) {
        throw new Error(`The Keychain refused to save ${item}: ${r.stderr.trim() || `exit ${r.code}`}`);
      }
    },
    async delete(item) {
      check(item);
      const r = await run(SECURITY, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', item]);
      if (r.code === NOT_FOUND) return false;
      if (r.code !== 0) throw new Error(`The Keychain refused to delete ${item}: ${r.stderr.trim() || `exit ${r.code}`}`);
      return true;
    },
  };
}
