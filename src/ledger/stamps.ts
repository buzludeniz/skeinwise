// Stamps: one OpenTimestamps proof per stamped ledger line, in ledger-proofs/ next to the ledger. A proof starts out
// pending at the calendar servers and is finished once `skeinwise ledger collect` brings back its Bitcoin block.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lineHash, type LedgerText } from './ledger.ts';
import { type BlockProof, bitcoinBlocks, parseProof, pendingCalendars, ProofError, type Timestamp } from './ots.ts';

export function proofsDir(home: string): string {
  return join(home, 'ledger-proofs');
}

export function proofPath(home: string, line: number): string {
  return join(proofsDir(home), `line-${line}.ots`);
}

export interface Stamp {
  line: number;
  path: string;
  /** In a Bitcoin block; waiting at the calendars; or a file that doesn't prove its line. */
  state: 'bitcoin' | 'pending' | 'bad';
  blocks: BlockProof[];
  /** The calendars a pending stamp waits on. */
  calendars: string[];
  problem?: string;
  /** The proof itself, when it could be read. */
  proof?: Timestamp;
}

/** The stamps in ledger-proofs/, oldest line first, each checked against the line it names. */
export function readStamps(home: string, ledger: LedgerText): Stamp[] {
  const dir = proofsDir(home);
  if (!existsSync(dir)) return [];
  const stamps: Stamp[] = [];
  for (const name of readdirSync(dir)) {
    const match = /^line-(\d+)\.ots$/.exec(name);
    if (!match) continue;
    const line = Number(match[1]);
    const path = join(dir, name);
    const base = { line, path, blocks: [], calendars: [] };
    let proof: Timestamp;
    try {
      proof = parseProof(readFileSync(path));
    } catch (err) {
      if (!(err instanceof ProofError)) throw err;
      stamps.push({ ...base, state: 'bad', problem: `${name} can't be read: ${err.message}` });
      continue;
    }
    const text = ledger.lines[line - 1];
    if (text === undefined || (ledger.cutOff && line === ledger.lines.length)) {
      stamps.push({ ...base, state: 'bad', problem: `${name} stamps line ${line}, which the ledger doesn't have.`, proof });
      continue;
    }
    if (Buffer.from(proof.msg).toString('hex') !== lineHash(text)) {
      stamps.push({ ...base, state: 'bad', problem: `${name} stamps a different line ${line}: the line was changed after it was stamped.`, proof });
      continue;
    }
    const blocks = bitcoinBlocks(proof);
    stamps.push({ ...base, state: blocks.length ? 'bitcoin' : 'pending', blocks, calendars: blocks.length ? [] : pendingCalendars(proof), proof });
  }
  return stamps.sort((a, b) => a.line - b.line);
}

/** Writes a proof file whole or not at all. */
export function writeProof(path: string, bytes: Uint8Array): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const part = `${path}.part`;
  writeFileSync(part, bytes, { mode: 0o600 });
  renameSync(part, path);
}
