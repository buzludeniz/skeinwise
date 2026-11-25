import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = /^[0-9a-f]{64}$/;

/** The per-install token the page sends with every API call. Made once, kept in the home folder, owner-only. */
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

export function sameToken(given: string | undefined, token: string): boolean {
  if (!given || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}
