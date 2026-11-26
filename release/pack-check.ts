// The package check (LS-20; the audit's L17 and supply/06): what `npm publish` would ship, read from
// `npm pack --dry-run --json` after a build. CI runs it on every OS (`pnpm pack:check`), and release.yml runs it before
// it publishes. It exits 1 and names each problem when the package must not ship.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface PackFile {
  path: string;
  size: number;
  mode: number;
}

/** No file in the package may reach 1 MB: the web bundle is the largest by far, and weights are gigabytes. */
export const MAX_FILE_BYTES = 1_000_000;

const SHIPS = /^(dist\/(src|web)\/|package\.json$|README\.md$|LICENSE$)/;
const WEIGHTS = /\.(gguf|ggml|safetensors|onnx|pt|pth|ckpt|bin|h5|tflite|mlmodel|npy|npz)$/i;
const SECRETS = /(^|\/)(\.env(\..*)?|\.npmrc|[^/]*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|token|credentials[^/]*)$/i;
const RECORDS = /\.(db|db-wal|db-shm|sqlite3?|jsonl)$/i;

/** Every reason this file list must not ship; empty when it can. `bin` is package.json's bin target. */
export function packProblems(files: readonly PackFile[], bin: string, platform: string = process.platform): string[] {
  const problems: string[] = [];
  const paths = new Set(files.map((f) => f.path));
  for (const need of [bin, 'dist/web/index.html', 'package.json', 'README.md', 'LICENSE']) {
    if (!paths.has(need)) problems.push(`${need} is missing`);
  }
  for (const f of files) {
    if (f.path.startsWith('dist/test/')) problems.push(`${f.path}: tests don't ship`);
    else if (!SHIPS.test(f.path)) problems.push(`${f.path}: outside dist/src and dist/web`);
    if (WEIGHTS.test(f.path)) problems.push(`${f.path}: looks like model weights`);
    if (SECRETS.test(f.path)) problems.push(`${f.path}: looks like a secret`);
    if (RECORDS.test(f.path)) problems.push(`${f.path}: looks like a record or a log`);
    if (f.path.startsWith('dist/') && f.path.endsWith('.json')) problems.push(`${f.path}: a JSON file in dist`);
    if (f.size >= MAX_FILE_BYTES) problems.push(`${f.path}: ${f.size} bytes, over the 1 MB limit`);
  }
  // Windows has no execute bit, so a package packed there can't be checked for one (CI checks it on the other two).
  const binFile = files.find((f) => f.path === bin);
  if (binFile && platform !== 'win32' && (binFile.mode & 0o111) === 0) {
    problems.push(`${bin} isn't executable (mode ${binFile.mode.toString(8)})`);
  }
  return problems;
}

/** package.json's bin target for the skeinwise command, as npm lists it ("./dist/x.js" becomes "dist/x.js"). */
export function binTarget(pkg: { bin?: string | Record<string, string> }): string {
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.skeinwise;
  if (!bin) throw new Error('package.json has no bin for skeinwise');
  return bin.replace(/^\.\//, '');
}

if (import.meta.main) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { bin?: string | Record<string, string> };
  // --ignore-scripts: check the build that is already in dist/, without prepack building it again.
  const out = execSync('npm pack --dry-run --json --ignore-scripts', { encoding: 'utf8' });
  const [pack] = JSON.parse(out) as Array<{ files: PackFile[]; size: number; unpackedSize: number; entryCount: number }>;
  if (!pack) throw new Error('npm pack printed no package');
  const problems = packProblems(pack.files, binTarget(pkg));
  const largest = [...pack.files].sort((a, b) => b.size - a.size)[0];
  console.log(`${pack.entryCount} files, ${pack.size} bytes packed, ${pack.unpackedSize} unpacked; largest ${largest?.path} at ${largest?.size} bytes`);
  for (const p of problems) console.error(`pack check: ${p}`);
  if (problems.length) process.exitCode = 1;
  else console.log('pack check: clean');
}
