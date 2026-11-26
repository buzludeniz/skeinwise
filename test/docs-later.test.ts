// README, CHANGELOG and the docs describe 1.0 as it ships. Something that isn't there yet is in README's "Coming in
// 1.1", or marked Later or planned, never promised for a version number ("come in version 0.5") or left as "not
// available yet". The release gate checks src/, web/src, README.md and docs/ for those words; this keeps the README,
// the CHANGELOG and the docs clean. (web/src/views/FirstRun.tsx said "come in version 0.5" until 9843bc9.)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

/** A promise for a version number, or a feature left as not there yet. */
const LATER = /\bcomes? in version|not available yet|in version 0\./i;

function markdown(path: string): string[] {
  const full = join(ROOT, path);
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full).flatMap((name) => markdown(`${path}/${name}`)).filter((f) => f.endsWith('.md'));
}

const docs = ['README.md', 'CHANGELOG.md', ...markdown('docs')];

describe('README, CHANGELOG and docs', () => {
  it('are all read', () => {
    expect(docs).toEqual(expect.arrayContaining(['README.md', 'CHANGELOG.md', 'docs/plan.md', 'docs/ui.md', 'docs/security.md']));
  });

  it('promise nothing for a version number, and leave nothing "not available yet"', () => {
    // A Windows checkout may end its lines with \r\n.
    const found = docs.flatMap((file) =>
      readFileSync(join(ROOT, file), 'utf8')
        .split(/\r?\n/)
        .flatMap((line, i) => (LATER.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(found).toEqual([]);
  });

  it("catches the first run's old wording and Settings' note", () => {
    expect(LATER.test('The agent servers come in version 0.5.')).toBe(true);
    expect(LATER.test('Not available yet. The choice is kept.')).toBe(true);
    expect(LATER.test('The record lives in ~/.skeinwise.')).toBe(false);
  });
});
