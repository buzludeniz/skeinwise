// The release machinery's checks: the package check (release/pack-check.ts, LS-20 and the audit's L17) and the
// release workflow's refusals (release/check-tag.ts, Deniz's decision 3a).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSection, distTag, releaseRefusal } from '../release/check-tag.ts';
import { binTarget, MAX_FILE_BYTES, type PackFile, packProblems } from '../release/pack-check.ts';

const root = join(import.meta.dirname, '..');
const BIN = 'dist/src/bin.js';
const file = (path: string, size = 1000, mode = 0o644): PackFile => ({ path, size, mode });
const CLEAN: PackFile[] = [
  file('LICENSE'),
  file('README.md'),
  file('package.json'),
  file(BIN, 600, 0o755),
  file('dist/src/cli.js', 20_000),
  file('dist/web/index.html'),
  file('dist/web/assets/index-abc.js', 725_000),
];

describe('the package check', () => {
  it('passes a clean build', () => {
    expect(packProblems(CLEAN, BIN, 'linux')).toEqual([]);
  });

  it('needs the bin, the web app, the README and the licence', () => {
    const without = (path: string) => CLEAN.filter((f) => f.path !== path);
    expect(packProblems(without(BIN), BIN, 'linux')).toEqual([`${BIN} is missing`]);
    expect(packProblems(without('dist/web/index.html'), BIN, 'linux')).toEqual(['dist/web/index.html is missing']);
    expect(packProblems(without('LICENSE'), BIN, 'linux')).toEqual(['LICENSE is missing']);
  });

  it("refuses supply/06's leftovers: tests, a .env and a JSON dump in dist", () => {
    const problems = packProblems([...CLEAN, file('dist/test/cli.test.js'), file('dist/.env'), file('dist/debug-record-dump.json')], BIN, 'linux');
    expect(problems).toEqual([
      "dist/test/cli.test.js: tests don't ship",
      'dist/.env: outside dist/src and dist/web',
      'dist/.env: looks like a secret',
      'dist/debug-record-dump.json: outside dist/src and dist/web',
      'dist/debug-record-dump.json: a JSON file in dist',
    ]);
  });

  it('refuses weights, records, keys and anything at 1 MB or more, even inside dist/src', () => {
    const problems = packProblems(
      [...CLEAN, file('dist/src/models/qwen.gguf', 10), file('dist/src/record.db', 10), file('dist/src/id_ed25519', 10), file('dist/web/assets/big.js', MAX_FILE_BYTES)],
      BIN,
      'linux',
    );
    expect(problems).toEqual([
      'dist/src/models/qwen.gguf: looks like model weights',
      'dist/src/record.db: looks like a record or a log',
      'dist/src/id_ed25519: looks like a secret',
      `dist/web/assets/big.js: ${MAX_FILE_BYTES} bytes, over the 1 MB limit`,
    ]);
  });

  it('needs the bin executable, except when packed on Windows, which has no execute bit', () => {
    const plain = CLEAN.map((f) => (f.path === BIN ? { ...f, mode: 0o644 } : f));
    expect(packProblems(plain, BIN, 'darwin')).toEqual([`${BIN} isn't executable (mode 644)`]);
    expect(packProblems(plain, BIN, 'win32')).toEqual([]);
  });

  it("reads package.json's bin as npm lists it", () => {
    expect(binTarget(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')))).toBe(BIN);
    expect(binTarget({ bin: './dist/src/bin.js' })).toBe(BIN);
    expect(() => binTarget({})).toThrow(/no bin/);
  });

  it('ships only dist/src and dist/web from dist, and builds them fresh before every pack', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[]; scripts: Record<string, string> };
    expect(pkg.files).toEqual(['dist/src', 'dist/web', 'README.md', 'LICENSE']);
    expect(pkg.scripts.prepack).toBe('npm run clean && npm run build');
    expect(pkg.scripts.build).toContain("chmodSync('dist/src/bin.js', 0o755)");
  });
});

describe("the release workflow's refusals", () => {
  const run = { eventName: 'push', ref: 'refs/tags/v1.0.0', refType: 'tag', version: '1.0.0' };

  it('lets the push of the tag that matches package.json through', () => {
    expect(releaseRefusal(run)).toBeUndefined();
    expect(releaseRefusal({ ...run, ref: 'refs/tags/v1.0.0-rc.1', version: '1.0.0-rc.1' })).toBeUndefined();
  });

  it('refuses any run that is not a tag push', () => {
    expect(releaseRefusal({ ...run, eventName: 'workflow_dispatch' })).toBe('the run came from a workflow_dispatch event, not a tag push');
    expect(releaseRefusal({ ...run, eventName: undefined })).toBe('the run came from a missing event, not a tag push');
    expect(releaseRefusal({ ...run, ref: 'refs/heads/main', refType: 'branch' })).toBe('the run came from refs/heads/main, not a tag');
  });

  it('refuses a tag that is not a version, or names another version', () => {
    expect(releaseRefusal({ ...run, ref: 'refs/tags/v1' })).toBe("v1 isn't a version tag (v1.2.3, or v1.2.3-rc.1 for a prerelease)");
    expect(releaseRefusal({ ...run, ref: 'refs/tags/1.0.0' })).toMatch(/isn't a version tag/);
    expect(releaseRefusal({ ...run, ref: 'refs/tags/v1.0.1' })).toBe("the tag is v1.0.1, but package.json's version is 1.0.0");
    expect(releaseRefusal({ ...run, version: '1.0.0-rc.1' })).toBe("the tag is v1.0.0, but package.json's version is 1.0.0-rc.1");
  });

  it('publishes a prerelease under next, never latest', () => {
    expect(distTag('1.0.0-rc.1')).toBe('next');
    expect(distTag('1.0.0')).toBe('latest');
  });

  it("takes the release notes from the version's CHANGELOG section, and finds none for a version without one", () => {
    const changelog = ['# Changelog', '', '## [Unreleased]', '', '- later', '', '## [1.0.0] - 2026-11-27', '', '### Added', '- npx skeinwise', '', '## [0.3.0] - 2026-11-20', '- older'].join('\n');
    expect(changelogSection(changelog, '1.0.0')).toBe('### Added\n- npx skeinwise');
    expect(changelogSection(changelog, '0.3.0')).toBe('- older');
    expect(changelogSection(changelog, '1.0.0-rc.1')).toBeUndefined();
    expect(changelogSection('## [1.0.0]\n\n## [0.3.0]\n- older', '1.0.0')).toBeUndefined();
  });
});

describe('the workflows', () => {
  // Comments stripped, so the header's own words ("no NPM_TOKEN") don't count as the thing they rule out.
  const workflow = (name: string) =>
    readFileSync(join(root, '.github/workflows', name), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .map((l) => l.replace(/\s#\s.*$/, ''))
      .join('\n');
  const ci = workflow('ci.yml');
  const release = workflow('release.yml');

  it('pin every action by commit SHA and leave no credentials in .git/config', () => {
    for (const text of [ci, release]) {
      const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
      expect(uses.length).toBeGreaterThan(0);
      for (const action of uses) expect(action, action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(text.match(/actions\/checkout@/g)?.length).toBe(text.match(/persist-credentials: false/g)?.length);
      expect(text).toMatch(/^permissions:/m);
      expect(text.match(/runs-on:/g)?.length).toBe(text.match(/timeout-minutes:/g)?.length);
    }
  });

  it('release only from a pushed version tag, never by hand or from a branch', () => {
    const on = release.slice(release.indexOf('\non:'), release.indexOf('\npermissions:'));
    expect(on).toContain('tags:');
    expect(on).not.toMatch(/branches|workflow_dispatch|pull_request|schedule|workflow_run|repository_dispatch/);
    expect(release).toContain('node release/check-tag.ts');
    expect(ci).not.toMatch(/npm publish|id-token/);
  });

  it('publish over OIDC from the publish job alone, with no token and no --provenance flag', () => {
    expect(release).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|--provenance|registry-url/);
    expect(release.match(/id-token: write/g)).toHaveLength(1);
    const publishJob = release.slice(release.indexOf('\n  publish:'), release.indexOf('\n  github-release:'));
    expect(publishJob).toContain('id-token: write');
    expect(publishJob).toContain('environment: npm');
    expect(publishJob).toContain(`tgz="skeinwise-$VERSION.tgz"`);
    expect(publishJob).toContain(`npm publish "$tgz" --tag "$DIST_TAG" --access public`);
    expect(release).toMatch(/^permissions: \{\}$/m);
  });
});
