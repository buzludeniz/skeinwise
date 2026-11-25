// The sync key and the two ways to open it. One random 256-bit key encrypts every bundle. The folder's key file holds
// that key twice, each copy encrypted (AES-256-GCM) with a key derived by scrypt: once from your passphrase, once from
// a 24-word recovery phrase that is shown only when the sync starts. Neither the passphrase nor the phrase is stored.

import { createCipheriv, createDecipheriv, randomBytes, randomInt, scryptSync } from 'node:crypto';
import { UsageError } from '../errors.ts';
import { WORDS } from './words.ts';

/** How hard scrypt works on each derivation: about a quarter of a second and 128 MB on a laptop. */
export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

export const SCRYPT: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

/** The shortest passphrase sync takes. The bundle can sit in a cloud folder for years, so it has to hold out. */
export const MIN_PASSPHRASE = 12;

export const PHRASE_WORDS = 24;

/** The key file's name in the sync folder. */
export const KEYS_FILE = 'skeinwise.keys';

export type SlotName = 'passphrase' | 'phrase';

/** One wrapped copy of the sync key, all binary values in base64. */
export interface Slot {
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  /** The encrypted key followed by its 16-byte GCM tag. */
  key: string;
}

export interface KeyFile {
  skeinwise: 'sync keys';
  format: 1;
  /** Names this sync: every bundle carries it, so a bundle can't be opened with another sync's key by mistake. */
  keyId: string;
  createdAt: string;
  slots: Record<SlotName, Slot>;
}

/** A new random sync key and its id. */
export function newKey(): { key: Buffer; keyId: string } {
  return { key: randomBytes(32), keyId: randomBytes(16).toString('hex') };
}

/** A new recovery phrase: 24 words, each picked uniformly from the 256, so 192 random bits in all. */
export function newPhrase(): string {
  return Array.from({ length: PHRASE_WORDS }, () => WORDS[randomInt(WORDS.length)]!).join(' ');
}

/** A phrase as typed or pasted: any case, spaces, line breaks, numbers like "1." from a written list. */
export function parsePhrase(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/\b\d+[.):]?/g, ' ')
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (words.length !== PHRASE_WORDS) {
    throw new UsageError(`A recovery phrase has ${PHRASE_WORDS} words; this one has ${words.length}.`);
  }
  const known = new Set(WORDS);
  const unknown = words.findIndex((w) => !known.has(w));
  if (unknown >= 0) throw new UsageError(`Word ${unknown + 1} of the recovery phrase, "${words[unknown]}", is not one of its words. Check it against what you wrote down.`);
  return words.join(' ');
}

/** A passphrase as given: Unicode-normalised so the same characters typed on another computer give the same key. */
export function checkPassphrase(text: string): string {
  const pass = text.normalize('NFC');
  if (!pass.trim()) throw new UsageError('The passphrase is empty.');
  if ([...pass].length < MIN_PASSPHRASE) {
    throw new UsageError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters; a few words strung together are easy to remember.`);
  }
  return pass;
}

/** Bounds on the scrypt settings a key file may ask for, so a damaged or hostile file can't make us spin or run out of memory. */
function checkParams(p: KdfParams): void {
  const powerOfTwo = Number.isInteger(p.N) && p.N >= 2 ** 10 && p.N <= 2 ** 20 && (p.N & (p.N - 1)) === 0;
  // scrypt uses 128 * N * r bytes: allow up to 512 MB, four times what Skeinwise asks for.
  const memoryOk = 128 * p.N * p.r <= 512 * 2 ** 20;
  if (!powerOfTwo || !memoryOk || !Number.isInteger(p.r) || p.r < 1 || !Number.isInteger(p.p) || p.p < 1 || p.p > 16) {
    throw new Error(`The key file asks for scrypt settings outside what Skeinwise uses (N=${p.N}, r=${p.r}, p=${p.p}). It is damaged or was not made by Skeinwise.`);
  }
}

function derive(secret: string, salt: Buffer, params: KdfParams): Buffer {
  checkParams(params);
  // scrypt needs 128 * N * r bytes; give it that and some room, since Node's default ceiling is 32 MB.
  return scryptSync(secret, salt, 32, { ...params, maxmem: 256 * params.N * params.r });
}

function slotAad(keyId: string, name: SlotName): Buffer {
  return Buffer.from(`skeinwise sync key ${keyId} ${name}`);
}

export function wrapKey(key: Buffer, keyId: string, name: SlotName, secret: string, params: KdfParams = SCRYPT): Slot {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(secret, salt, params), iv);
  cipher.setAAD(slotAad(keyId, name));
  const sealed = Buffer.concat([cipher.update(key), cipher.final(), cipher.getAuthTag()]);
  return { kdf: 'scrypt', ...params, salt: salt.toString('base64'), iv: iv.toString('base64'), key: sealed.toString('base64') };
}

/** The sync key, or null when the secret doesn't open this slot (a wrong secret, or a slot that was changed). */
export function unwrapKey(slot: Slot, keyId: string, name: SlotName, secret: string): Buffer | null {
  const sealed = Buffer.from(slot.key, 'base64');
  if (sealed.length !== 32 + 16) return null;
  const decipher = createDecipheriv('aes-256-gcm', derive(secret, Buffer.from(slot.salt, 'base64'), slot), Buffer.from(slot.iv, 'base64'));
  decipher.setAAD(slotAad(keyId, name));
  decipher.setAuthTag(sealed.subarray(32));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, 32)), decipher.final()]);
  } catch {
    return null;
  }
}

export function makeKeyFile(key: Buffer, keyId: string, passphrase: string, phrase: string, now: string, params: KdfParams = SCRYPT): KeyFile {
  return {
    skeinwise: 'sync keys',
    format: 1,
    keyId,
    createdAt: now,
    slots: { passphrase: wrapKey(key, keyId, 'passphrase', passphrase, params), phrase: wrapKey(key, keyId, 'phrase', phrase, params) },
  };
}

/** Reads a key file's text, or says plainly what is wrong with it. */
export function parseKeyFile(text: string, where: string): KeyFile {
  let file: KeyFile;
  try {
    file = JSON.parse(text) as KeyFile;
  } catch {
    throw new Error(`${where} is not a Skeinwise key file: it isn't JSON.`);
  }
  if (file?.skeinwise !== 'sync keys') throw new Error(`${where} is not a Skeinwise key file.`);
  if (file.format !== 1) throw new Error(`${where} was written by a newer Skeinwise (key file format ${file.format}). Update Skeinwise to open it.`);
  const slotOk = (s: Slot | undefined) =>
    !!s && s.kdf === 'scrypt' && [s.N, s.r, s.p].every((n) => typeof n === 'number') && [s.salt, s.iv, s.key].every((v) => typeof v === 'string');
  if (typeof file.keyId !== 'string' || !/^[0-9a-f]{32}$/.test(file.keyId) || !slotOk(file.slots?.passphrase) || !slotOk(file.slots?.phrase)) {
    throw new Error(`${where} is damaged: a part of it is missing.`);
  }
  return file;
}
