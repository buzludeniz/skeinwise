import { describe, expect, it } from 'vitest';
import { checkPassphrase, type KdfParams, makeKeyFile, newKey, newPhrase, parseKeyFile, parsePhrase, PHRASE_WORDS, unwrapKey, wrapKey } from '../../src/sync/keys.ts';
import { WORDS } from '../../src/sync/words.ts';

// The key scheme on its own. Every passphrase and phrase here is made up for the test; scrypt runs on light settings
// (the sync tests use the real ones at least once).

const LIGHT: KdfParams = { N: 2 ** 10, r: 8, p: 1 };
const PASS = 'test passphrase not real';

describe('the recovery phrase words', () => {
  it('are 256 distinct words, none sharing its first four letters with another and none the start of another', () => {
    expect(WORDS).toHaveLength(256);
    expect(new Set(WORDS).size).toBe(256);
    expect(new Set(WORDS.map((w) => w.slice(0, 4))).size).toBe(256);
    for (const a of WORDS) for (const b of WORDS) if (a !== b) expect(b.startsWith(a)).toBe(false);
    for (const w of WORDS) expect(w).toMatch(/^[a-z]{3,8}$/);
  });

  it('a new phrase is 24 of them, and reads back however it is written down', () => {
    const phrase = newPhrase();
    const words = phrase.split(' ');
    expect(words).toHaveLength(PHRASE_WORDS);
    for (const w of words) expect(WORDS).toContain(w);
    const written = words.map((w, i) => `${i + 1}. ${w.toUpperCase()}`).join('\n');
    expect(parsePhrase(written)).toBe(phrase);
    expect(parsePhrase(`  ${words.join(',  ')} `)).toBe(phrase);
  });

  it('a phrase with a word missing or misspelt is refused, naming the word', () => {
    const words = newPhrase().split(' ');
    expect(() => parsePhrase(words.slice(1).join(' '))).toThrow(/has 24 words; this one has 23/);
    const wrong = [...words];
    wrong[6] = 'notaword';
    expect(() => parsePhrase(wrong.join(' '))).toThrow(/Word 7 of the recovery phrase, "notaword"/);
  });
});

describe('the passphrase', () => {
  it('needs 14 characters, counted as characters, or 5 words, and is normalised', () => {
    expect(() => checkPassphrase('')).toThrow(/empty/);
    expect(() => checkPassphrase('              ')).toThrow(/empty/);
    expect(() => checkPassphrase('short one')).toThrow(/at least 14 characters, or 5 or more words/);
    expect(() => checkPassphrase('çay çay çay!')).toThrow(/at least 14 characters/); // 12 characters, 3 words
    expect(() => checkPassphrase('çay çay çay ça')).not.toThrow(); // 14 characters, counted as characters
    expect(checkPassphrase('çay çay çay çay')).toBe('çay çay çay çay');
    expect(checkPassphrase('猫 犬 空 海 山')).toBe('猫 犬 空 海 山'); // 9 characters, 5 words
    expect(() => checkPassphrase('猫 犬 空 海')).toThrow(/at least 14 characters/);
    // The same letters typed as one character or as a letter and an accent give the same passphrase.
    expect(checkPassphrase('café au lait x')).toBe(checkPassphrase('café au lait x'));
  });
});

describe('wrapping the sync key', () => {
  it('opens with the right secret only, and only in its own slot of its own sync', () => {
    const { key, keyId } = newKey();
    const slot = wrapKey(key, keyId, 'passphrase', PASS, LIGHT);
    expect(unwrapKey(slot, keyId, 'passphrase', PASS)).toEqual(key);
    expect(unwrapKey(slot, keyId, 'passphrase', `${PASS}!`)).toBeNull();
    expect(unwrapKey(slot, keyId, 'phrase', PASS)).toBeNull();
    expect(unwrapKey(slot, newKey().keyId, 'passphrase', PASS)).toBeNull();
    // Each wrap is salted afresh: the same key and secret never look the same twice.
    expect(wrapKey(key, keyId, 'passphrase', PASS, LIGHT).key).not.toBe(slot.key);
  });

  it('a changed slot opens with nothing', () => {
    const { key, keyId } = newKey();
    const slot = wrapKey(key, keyId, 'phrase', 'made up phrase', LIGHT);
    const bytes = Buffer.from(slot.key, 'base64');
    bytes[3]! ^= 1;
    expect(unwrapKey({ ...slot, key: bytes.toString('base64') }, keyId, 'phrase', 'made up phrase')).toBeNull();
    expect(unwrapKey({ ...slot, key: bytes.subarray(0, 40).toString('base64') }, keyId, 'phrase', 'made up phrase')).toBeNull();
  });

  it('a key file reads back, and a damaged or hostile one is refused before any work', () => {
    const { key, keyId } = newKey();
    const file = makeKeyFile(key, keyId, PASS, newPhrase(), '2026-11-25T10:00:00.000Z', LIGHT);
    const text = JSON.stringify(file);
    expect(parseKeyFile(text, 'k')).toEqual(file);
    expect(() => parseKeyFile('{', 'k')).toThrow(/isn't JSON/);
    expect(() => parseKeyFile('{"skeinwise":"other"}', 'k')).toThrow(/not a Skeinwise key file/);
    expect(() => parseKeyFile(JSON.stringify({ ...file, format: 2 }), 'k')).toThrow(/newer Skeinwise/);
    expect(() => parseKeyFile(JSON.stringify({ ...file, keyId: 'x' }), 'k')).toThrow(/damaged/);
    // A file asking scrypt for gigabytes of memory is refused, not obeyed.
    const greedy = { ...file.slots.passphrase, N: 2 ** 20, r: 32 };
    expect(() => unwrapKey(greedy, keyId, 'passphrase', PASS)).toThrow(/scrypt settings outside/);
    expect(() => unwrapKey({ ...file.slots.passphrase, N: 3000 }, keyId, 'passphrase', PASS)).toThrow(/scrypt settings outside/);
  });
});
