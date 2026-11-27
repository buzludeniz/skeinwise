// The app's screens carry our own names. This fails the run when an old screen name comes back into the page's
// source, the CLI and server source (its help text and comments ship in the package), its e2e test, the docs or the
// README: as a label, a heading, a class or a comment.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SCANNED = ['src', 'web/src', 'web/index.html', 'e2e', 'docs', 'README.md'];
const SKIPPED = new Set(['node_modules', '.run']);

/** The old names, each with the one that replaced it. */
const OLD: [RegExp, string][] = [
  [/\bNavigator\b/, 'Navigator is now Threads'],
  [/\bNumbers\b/, 'Numbers is now Stats'],
  [/\bLab\b/, 'Lab is now Workbench'],
  [/\bLearn\b/, 'Learn is now Guide'],
  [/['"`>]You['"`<]/, 'the You screen is now Profile'],
  [/brainstem|\bspine\b|vertebra/i, 'the brainstem and spine are now the stem'],
  [/record live\b/i, 'Record live is now Live capture'], // not "the record lives in"
  [/\btides\b/i, 'Tides is now Activity'],
  [/year rings?/i, 'Year rings is now the Activity layout'],
];

/** Text that keeps an old word on purpose, and why. Each must still be there, so a stale entry fails too. */
const ALLOWED: { file: string; text: string; why: string }[] = [
  { file: 'web/src/types.ts', text: 'Numbers as Stats', why: "the server's type name, in src/server/queries.ts" },
  { file: 'web/src/types.ts', text: 'calls the Stats figures `Numbers`', why: 'the comment on that alias' },
  { file: 'web/src/views/Workbench.tsx', text: '`tides${qs({ by })}`', why: "the server's route, /api/tides" },
  { file: 'web/src/format.ts', text: "return 'You';", why: 'the speaker label on your own words, not a screen' },
  { file: 'web/src/views/Reader.tsx', text: "v.editor === 'you' ? 'You'", why: "a version's editor when that was you" },
  { file: 'docs/brand/README.md', text: 'crosses a straight spine', why: "the logo's letter S, not the brain" },
  { file: 'src/server/queries.ts', text: 'interface Numbers', why: "the Stats figures' type, which the web aliases" },
  { file: 'src/server/queries.ts', text: '): Numbers {', why: 'that type, returned by numbers()' },
  { file: 'src/server/queries.ts', text: "Numbers['bySource']", why: 'that type, in a cast' },
  { file: 'src/server/queries.ts', text: "Numbers['bySpeaker']", why: 'that type, in a cast' },
  { file: 'src/server/buckets.ts', text: 'export function tides(', why: 'the function behind /api/tides' },
  { file: 'src/server/app.ts', text: 'type TableProp, tides,', why: 'its import' },
  { file: 'src/server/app.ts', text: '/^\\/api\\/tides$/', why: "the route the Workbench's activity lines read" },
  { file: 'src/server/app.ts', text: 'return tides(', why: 'the call in that route' },
];

function files(path: string): string[] {
  const full = join(ROOT, path);
  if (!statSync(full).isDirectory()) return [path];
  return readdirSync(full)
    .filter((name) => !SKIPPED.has(name))
    .flatMap((name) => files(`${path}/${name}`)); // '/' on every OS, as in ALLOWED and SCANNED
}

const sources = SCANNED.flatMap(files).filter((f) => /\.(tsx?|css|html|md)$/.test(f));

describe('screen names', () => {
  it('scans the page source, the CLI and server source, the e2e test, the docs and the README', () => {
    expect(sources).toContain('src/cli.ts');
    expect(sources).toContain('src/server/app.ts');
    expect(sources).toContain('docs/ui.md');
    expect(sources).toContain('docs/plan.md');
    expect(sources).toContain('README.md');
    expect(sources).toContain('web/src/ui/Rail.tsx');
    expect(sources).toContain('web/src/styles.css');
    expect(sources).toContain('e2e/smoke.e2e.ts');
  });

  it('uses none of the old names', () => {
    const found: string[] = [];
    for (const file of sources) {
      const allowed = ALLOWED.filter((a) => a.file === file);
      readFileSync(join(ROOT, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const rest = allowed.reduce((l, a) => l.replace(a.text, ''), line);
          for (const [pattern, now] of OLD) {
            if (pattern.test(rest)) found.push(`${relative('.', file)}:${i + 1}: ${now}: ${line.trim()}`);
          }
        });
    }
    expect(found).toEqual([]);
  });

  it('allows only text that is still there', () => {
    const missing = ALLOWED.filter((a) => !readFileSync(join(ROOT, a.file), 'utf8').includes(a.text));
    expect(missing).toEqual([]);
  });

  it('puts the new names on the rail, in order', () => {
    const rail = readFileSync(join(ROOT, 'web/src/ui/Rail.tsx'), 'utf8');
    const labels = [...rail.matchAll(/\{ target: '\w+', label: '([^']+)'/g)].map((m) => m[1]);
    expect(labels).toEqual(['Brain', 'Threads', 'Stats', 'Timeline', 'Profile', 'Workbench', 'Views', 'Assistant', 'Guide', 'Add']);
  });
});
