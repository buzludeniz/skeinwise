// Files the page uploads land in home/imports/<batch>/ before they are imported. The size cap counts the bytes that
// actually arrive, so a chunked body (no Content-Length) can't get past it (L2), and nothing half-written stays.

import { closeSync, constants, createWriteStream, lstatSync, openSync, readdirSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const UPLOAD_LIMIT = 1024 * 1024 * 1024;
export const BATCH_ID = /^[a-z0-9]{8,40}$/;
/** Batches older than this are removed when the server starts. */
const BATCH_AGE_MS = 24 * 60 * 60 * 1000;

/** The client went away before the body ended; the caller turns it into a 400 nobody reads. */
export class CutOff extends Error {
  constructor() {
    super('The upload was cut off');
  }
}

/** The error for a body over the cap; the caller turns it into a 413. */
export class TooLarge extends Error {
  constructor(limit: number) {
    const mb = limit / (1024 * 1024);
    super(`That file is larger than ${mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}`);
  }
}

/**
 * Streams a request body into a new owner-only file, counting the bytes. Over `limit`, or when the client goes away,
 * the file is deleted and the promise rejects. The request is left readable after a TooLarge, so the rest of the body
 * drains and the client gets the answer instead of a broken connection.
 */
export async function saveUpload(raw: IncomingMessage, file: string, limit: number): Promise<void> {
  if (Number(raw.headers['content-length'] ?? 0) > limit) throw new TooLarge(limit);
  // Opened here, with no symlink followed, so the file exists (and can be removed) whatever happens next.
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  let out;
  try {
    out = createWriteStream(file, { fd });
  } catch (error) {
    closeSync(fd);
    rmSync(file, { force: true });
    throw error;
  }
  // The body goes through a stream of its own, so a failure destroys that, not the request and its connection.
  const body = new PassThrough();
  const cutOff = () => {
    if (!raw.complete) body.destroy(new CutOff());
  };
  raw.once('close', cutOff);
  raw.pipe(body);
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) done(new TooLarge(limit));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, out);
  } catch (error) {
    rmSync(file, { force: true });
    raw.unpipe(body);
    raw.resume();
    throw error;
  } finally {
    raw.off('close', cutOff);
  }
}

/** Removes upload batches older than a day: they were imported or abandoned. Returns how many went. */
export function cleanUploads(home: string, now = Date.now()): number {
  const dir = join(home, 'imports');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!BATCH_ID.test(name)) continue;
    const path = join(dir, name);
    try {
      if (now - lstatSync(path).mtimeMs <= BATCH_AGE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Gone already, or not ours to remove: leave it.
    }
  }
  return removed;
}
