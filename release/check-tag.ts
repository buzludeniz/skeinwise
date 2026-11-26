// The release workflow's first step (release.yml). It refuses to go on unless this run is the push of a version tag
// and the tag names package.json's version, and unless CHANGELOG.md has a section for that
// version. It writes the npm dist-tag for the publish job (`next` for a prerelease such as 1.0.0-rc.1, `latest`
// otherwise) and the version's CHANGELOG section as the GitHub release's notes.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

export interface TagRun {
  /** GITHUB_EVENT_NAME */
  eventName: string | undefined;
  /** GITHUB_REF, such as refs/tags/v1.0.0 */
  ref: string | undefined;
  /** GITHUB_REF_TYPE: branch or tag */
  refType: string | undefined;
  /** package.json's version */
  version: string;
}

const VERSION_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Why this run must not publish, or undefined when it may. */
export function releaseRefusal(run: TagRun): string | undefined {
  if (run.eventName !== 'push') return `the run came from a ${run.eventName ?? 'missing'} event, not a tag push`;
  if (run.refType !== 'tag' || !run.ref?.startsWith('refs/tags/')) return `the run came from ${run.ref ?? 'no ref'}, not a tag`;
  const tag = run.ref.slice('refs/tags/'.length);
  if (!VERSION_TAG.test(tag)) return `${tag} isn't a version tag (v1.2.3, or v1.2.3-rc.1 for a prerelease)`;
  if (tag !== `v${run.version}`) return `the tag is ${tag}, but package.json's version is ${run.version}`;
  return undefined;
}

/** The npm dist-tag a version goes out under: a prerelease must never become `latest`. */
export const distTag = (version: string): 'next' | 'latest' => (version.includes('-') ? 'next' : 'latest');

/** The body of CHANGELOG.md's section for `version` (a heading such as `## [1.0.0] - 2026-11-27`), or undefined. */
export function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## /.test(l) && (l.startsWith(`## [${version}]`) || l.startsWith(`## ${version} `) || l === `## ${version}`));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
  return body || undefined;
}

if (import.meta.main) {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  const env = process.env;
  const refusal = releaseRefusal({ eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, refType: env.GITHUB_REF_TYPE, version });
  const notes = refusal ? undefined : changelogSection(readFileSync('CHANGELOG.md', 'utf8'), version);
  const problem = refusal ?? (notes ? undefined : `CHANGELOG.md has no section for ${version}`);
  if (problem) {
    console.error(`::error::Refusing to release: ${problem}.`);
    process.exit(1);
  }
  writeFileSync('release-notes.md', `${notes}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `version=${version}\ndist-tag=${distTag(version)}\n`);
  console.log(`Releasing ${version} under the npm dist-tag ${distTag(version)}.`);
}
