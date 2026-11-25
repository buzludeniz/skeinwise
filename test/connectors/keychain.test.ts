import { describe, expect, it, vi } from 'vitest';
import { keychainItems, macKeychain, type Runner } from '../../src/connectors/keychain.ts';

// The real `security` command must never run in a test: no real Keychain is read or written.
vi.mock('node:child_process', () => ({
  spawn: () => {
    throw new Error('No processes in this test');
  },
}));

interface Ran {
  command: string;
  args: string[];
  input: string | undefined;
}

/** A pretend `security` that keeps items in a map. */
function fakeSecurity(): { run: Runner; ran: Ran[]; store: Map<string, string> } {
  const ran: Ran[] = [];
  const store = new Map<string, string>();
  const run: Runner = async (command, args, input) => {
    ran.push({ command, args, input });
    const account = args[args.indexOf('-a') + 1] ?? '';
    if (args[0] === '-i') {
      const words = (input ?? '').trim().split(/\s+/);
      store.set(words[words.indexOf('-a') + 1]!, words[words.indexOf('-w') + 1]!);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'find-generic-password') {
      const v = store.get(account);
      return v === undefined ? { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' } : { code: 0, stdout: `${v}\n`, stderr: '' };
    }
    if (args[0] === 'delete-generic-password') {
      return store.delete(account) ? { code: 0, stdout: '', stderr: '' } : { code: 44, stdout: '', stderr: 'not found' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { run, ran, store };
}

describe('the macOS Keychain', () => {
  it('saves a secret through standard input, never in the command line, and reads it back', async () => {
    const security = fakeSecurity();
    const keychain = macKeychain(security.run);
    const secret = '{"access":"test-access-token","refresh":"test-refresh-token"}';
    await keychain.set('abc123/gmail/token', secret);
    expect(await keychain.get('abc123/gmail/token')).toBe(secret);
    const save = security.ran[0]!;
    expect(save.command).toBe('/usr/bin/security');
    expect(save.args).toEqual(['-i']);
    expect(save.args.join(' ')).not.toContain('test-access-token');
    expect(save.input).toContain('add-generic-password -U -s skeinwise -a abc123/gmail/token -w ');
    // Encoded, so quotes and spaces in the token can't break the line `security -i` reads.
    expect(save.input).not.toContain('test-access-token');
    for (const r of security.ran) expect(r.args.join(' ')).not.toContain('test-');
  });

  it('says null for a missing item and false for deleting one that is not there', async () => {
    const keychain = macKeychain(fakeSecurity().run);
    expect(await keychain.get('abc123/slack/token')).toBeNull();
    expect(await keychain.delete('abc123/slack/token')).toBe(false);
    await keychain.set('abc123/slack/token', 'xoxp-test-not-a-real-token');
    expect(await keychain.delete('abc123/slack/token')).toBe(true);
    expect(await keychain.get('abc123/slack/token')).toBeNull();
  });

  it('refuses an item name that could smuggle words into the security command', async () => {
    const keychain = macKeychain(fakeSecurity().run);
    await expect(keychain.set('x -w other', 'secret')).rejects.toThrow('Not a usable Keychain item name');
  });

  it('fails loudly when the Keychain refuses', async () => {
    const keychain = macKeychain(async () => ({ code: 51, stdout: '', stderr: 'User interaction is not allowed.' }));
    await expect(keychain.get('abc123/gmail/token')).rejects.toThrow('User interaction is not allowed.');
  });

  it('keeps each record folder’s tokens apart', () => {
    const a = keychainItems('/Users/someone/.skeinwise', 'gmail');
    const b = keychainItems('/Users/someone/skeinwise-demo', 'gmail');
    expect(a.token).toMatch(/^[0-9a-f]{12}\/gmail\/token$/);
    expect(a.token).not.toBe(b.token);
    expect(a.clientSecret).toBe(a.token.replace('/token', '/client-secret'));
  });
});
