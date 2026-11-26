import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = /^[0-9a-f]{64}$/;

/** The token kept from the last run, or a new one when there is none: `serve --keep-token`. */
export function loadToken(home: string): string {
  const file = join(home, 'token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (TOKEN.test(existing)) return existing;
  } catch {
    // No token yet: make one below.
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

/**
 * A new token for this run of the server, written to the record folder (owner-only) for the agents' window server
 * to read. A URL from an earlier run stops working (L9). The file is replaced, never written through, so a symlink at
 * its name can't send the token anywhere else.
 */
export function newToken(home: string): string {
  const file = join(home, 'token');
  // Safe on Windows too, where O_EXCL follows a dangling link: the name is random and new, so no link can wait there.
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const token = randomBytes(32).toString('hex');
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  return token;
}

/**
 * Whether the header holds the token. Both sides are hashed first, so the comparison takes the same time whatever was
 * sent, and a header of any length or alphabet is just a wrong token (L10), never an error.
 */
export function sameToken(given: string | undefined, token: string): boolean {
  if (typeof given !== 'string' || !given) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(token));
}
