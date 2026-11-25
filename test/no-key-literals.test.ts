// The no-key-literals check: fails when a file in the repo holds a literal in a provider's key format. GitHub's secret
// scanning flags such a literal even when it is a fake test sample, so samples are joined from parts at run time
// (`keyShaped` in test/samples.ts). It reads every tracked file and every new one git doesn't ignore, so it fails
// before a commit, and CI runs it with the rest of `pnpm test`. It names the file, line and format, never the value.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyShaped } from './samples.ts';

const root = join(import.meta.dirname, '..');

/**
 * Each format is its prefix and enough key characters to look like a key, so a prefix on its own (a regex, a
 * `startsWith`, "it starts with xoxp-" in help text) passes. The generic prefixes `sk-` and `hf_` need a longer body.
 */
const KEY_FORMATS: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ['Google API key', /\bAIza[0-9A-Za-z_-]{4,}/],
  ['Anthropic or OpenAI project key', /\bsk-(?:ant|proj)-[0-9A-Za-z_-]{4,}/],
  ['OpenAI key', /\bsk-[0-9A-Za-z_-]{16,}/],
  ['GitHub token', /\bgh[pousr]_[0-9A-Za-z]{4,}/],
  ['GitHub fine-grained token', /\bgithub_pat_[0-9A-Za-z_]{4,}/],
  ['Slack token', /\bxox[abprs]-[0-9A-Za-z-]{4,}/],
  ['Hugging Face token', /\bhf_[0-9A-Za-z]{20,}/],
  ['AWS access key ID', /\bAKIA[0-9A-Z]{16}/],
  ['Stripe live key', /\b[rs]k_live_[0-9A-Za-z]{4,}/],
  ['Google OAuth client secret', /\bGOCSPX-[0-9A-Za-z_-]{4,}/],
  ['Private key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
];

interface Hit {
  file: string;
  line: number;
  format: string;
}

export function keyLiterals(text: string, file = ''): Hit[] {
  const hits: Hit[] = [];
  text.split('\n').forEach((line, i) => {
    for (const [format, pattern] of KEY_FORMATS) if (pattern.test(line)) hits.push({ file, line: i + 1, format });
  });
  return hits;
}

function repoFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  return [...new Set(out.split('\0').filter(Boolean))];
}

describe('the no-key-literals check', () => {
  it('finds no literal in a provider key format in any file in the repo', () => {
    const files = repoFiles();
    expect(files).toContain('test/no-key-literals.test.ts');
    const hits: Hit[] = [];
    for (const file of files) {
      const path = join(root, file);
      if (!existsSync(path)) continue; // deleted and not yet committed
      const bytes = readFileSync(path);
      if (bytes.subarray(0, 8000).includes(0)) continue; // binary
      hits.push(...keyLiterals(bytes.toString('utf8'), file));
    }
    expect(hits.map((h) => `${h.file}:${h.line} looks like a ${h.format}; join it from parts with keyShaped()`)).toEqual([]);
  });

  it('catches each format, built here from parts', () => {
    const samples: Array<[string, string]> = [
      ['Google API key', keyShaped('AI', 'zaSyD-fake-0123456789abcdefghijklmnopq')],
      ['Anthropic or OpenAI project key', keyShaped('sk', '-ant-api03-fake')],
      ['Anthropic or OpenAI project key', keyShaped('sk', '-proj-fake0123')],
      ['OpenAI key', keyShaped('s', 'k-', 'fake0123456789abcdefghij')],
      ['GitHub token', keyShaped('gh', 'p_fake0123456789')],
      ['GitHub fine-grained token', keyShaped('github', '_pat_fake_0123')],
      ['Slack token', keyShaped('xo', 'xp-test')],
      ['Hugging Face token', keyShaped('h', 'f_fake0123456789abcdefghij')],
      ['AWS access key ID', keyShaped('AK', 'IAFAKE0123456789AB')],
      ['Stripe live key', keyShaped('sk', '_live_fake')],
      ['Google OAuth client secret', keyShaped('GOC', 'SPX-fake')],
      ['Private key', keyShaped('-----BEGIN RSA PRI', 'VATE KEY-----')],
    ];
    for (const [format, sample] of samples) expect(keyLiterals(`const key = '${sample}';`).map((h) => h.format)).toContain(format);
  });

  it('lets a prefix on its own through: in a regex, a startsWith, help text, or inside a word', () => {
    const fine = [
      String.raw`const google = /\bAIza[0-9A-Za-z_-]{35}\b/;`,
      "if (!token.startsWith('xoxp-')) throw new Error('those start with xoxp-');",
      'A bot token (xoxb-) reads as the app.',
      'the risk-assessment-framework-for-everyone, a task_live_view',
      String.raw`const pem = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;`,
    ];
    for (const line of fine) expect(keyLiterals(line)).toEqual([]);
  });
});
