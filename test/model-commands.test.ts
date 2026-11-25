import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Io, main } from '../src/cli.ts';
import { setConfigValue } from '../src/config.ts';
import { gigabytes, SUGGESTED, serveCommand } from '../src/model-commands.ts';

// `skeinwise model check|fetch|serve`, against a fake model server, a fake Hugging Face and a fake llama-server.

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeinwise-model-'));
  home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function sw(argv: string[], io: Partial<Io> = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    out: (t) => (out += t),
    err: (t) => (err += t),
    env: { SKEINWISE_HOME: home, PATH: '' },
    fetch: (async (input: string | URL | Request) => {
      throw new Error(`No network in this test, but something fetched ${String(input)}`);
    }) as typeof fetch,
    ...io,
  });
  return { code, out, err };
}

// A made-up model file: 300 kB of bytes that are not all the same.
const WEIGHTS = new Uint8Array(300_000).map((_, i) => (i * 31 + (i >> 8)) % 251);
const SHA = createHash('sha256').update(WEIGHTS).digest('hex');

interface HubOpts {
  bytes?: Uint8Array;
  sha?: string;
  ignoreRange?: boolean;
}

/** A fake Hugging Face: the tree listing and the file, with range requests. */
function fakeHub(opts: HubOpts = {}) {
  const requests: { url: string; range: string | null }[] = [];
  const bytes = opts.bytes ?? WEIGHTS;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const range = (init?.headers as Record<string, string> | undefined)?.range ?? null;
    requests.push({ url, range });
    if (url === `https://huggingface.co/api/models/${SUGGESTED.repo}/tree/main`) {
      return Response.json([
        { type: 'file', path: 'README.md', size: 900 },
        { type: 'file', path: SUGGESTED.file, size: WEIGHTS.length, lfs: { oid: opts.sha ?? SHA, size: WEIGHTS.length } },
      ]);
    }
    if (url === `https://huggingface.co/${SUGGESTED.repo}/resolve/main/${SUGGESTED.file}`) {
      const from = range && !opts.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      return new Response(bytes.slice(from), { status: from ? 206 : 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, requests, downloads: () => requests.filter((r) => r.url.includes('/resolve/')) };
}

const target = () => join(home, 'models', SUGGESTED.file);

describe('skeinwise model fetch', () => {
  it('shows the size and source, and downloads nothing without a yes', async () => {
    const hub = fakeHub();
    const r = await sw(['model', 'fetch'], { fetch: hub.fetch });
    expect(r.code).toBe(2);
    expect(r.out).toContain(`Qwen3-4B, quantised to Q4_K_M: 300 kB\n  from https://huggingface.co/${SUGGESTED.repo}/resolve/main/${SUGGESTED.file}\n  to   ${target()}\n`);
    expect(r.err).toContain('Add --yes to download it.');
    expect(hub.downloads()).toEqual([]);

    const no = await sw(['model', 'fetch'], { fetch: hub.fetch, ask: async () => 'n' });
    expect(no.code).toBe(0);
    expect(no.out).toMatch(/Nothing was downloaded\.\n$/);
    expect(hub.downloads()).toEqual([]);
    expect(existsSync(target())).toBe(false);
  });

  it('downloads on a yes, checks the sha256, and says so the second time', async () => {
    const hub = fakeHub();
    const questions: string[] = [];
    const r = await sw(['model', 'fetch'], {
      fetch: hub.fetch,
      ask: async (q) => {
        questions.push(q);
        return 'y';
      },
    });
    expect(r.code).toBe(0);
    expect(questions).toEqual(['Download 300 kB now? [y/N] ']);
    expect(r.out).toContain(`Saved ${target()} (300 kB, sha256 checked).`);
    expect(r.err).toContain('(100%)');
    expect(createHash('sha256').update(readFileSync(target())).digest('hex')).toBe(SHA);
    expect(existsSync(`${target()}.part`)).toBe(false);

    const again = await sw(['model', 'fetch', '--yes'], { fetch: hub.fetch });
    expect(again.out).toContain(`${SUGGESTED.file} is already in ${join(home, 'models')}`);
    expect(hub.downloads()).toHaveLength(1);
  });

  it('deletes a download whose sha256 does not match, and saves nothing', async () => {
    const hub = fakeHub({ sha: 'a'.repeat(64) });
    const r = await sw(['model', 'fetch', '--yes'], { fetch: hub.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`The download's sha256 is ${SHA}, but the source lists ${'a'.repeat(64)}. It was deleted; nothing was saved.`);
    expect(existsSync(target())).toBe(false);
    expect(existsSync(`${target()}.part`)).toBe(false);
  });

  it('keeps a cut-off download and fetches only the rest next time', async () => {
    const cut = fakeHub({ bytes: WEIGHTS.slice(0, 120_000) });
    const first = await sw(['model', 'fetch', '--yes'], { fetch: cut.fetch });
    expect(first.code).toBe(1);
    expect(first.err).toContain('The download stopped at 120000 of 300000 bytes. Run skeinwise model fetch again to fetch the rest.');
    expect(readFileSync(`${target()}.part`)).toHaveLength(120_000);

    const hub = fakeHub();
    const r = await sw(['model', 'fetch', '--yes'], { fetch: hub.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toContain('120 kB came down before; the rest follows.');
    expect(hub.downloads()).toEqual([expect.objectContaining({ range: 'bytes=120000-' })]);
    expect(createHash('sha256').update(readFileSync(target())).digest('hex')).toBe(SHA);
  });

  it('starts over when the server ignores the range', async () => {
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(`${target()}.part`, WEIGHTS.slice(0, 50_000));
    const hub = fakeHub({ ignoreRange: true });
    expect((await sw(['model', 'fetch', '--yes'], { fetch: hub.fetch })).code).toBe(0);
    expect(createHash('sha256').update(readFileSync(target())).digest('hex')).toBe(SHA);
  });

  it('refuses when the source no longer lists a sha256', async () => {
    const fetch = (async () => Response.json([{ path: SUGGESTED.file, size: 10 }])) as typeof globalThis.fetch;
    const r = await sw(['model', 'fetch', '--yes'], { fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain('no longer lists Qwen3-4B-Q4_K_M.gguf with a size and sha256');
  });
});

describe('skeinwise model check', () => {
  const server = (content: string, down = false) =>
    (async (input: string | URL | Request) => {
      if (down) throw new TypeError('fetch failed');
      if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'models/fake-4b.gguf' }] });
      return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 31, completion_tokens: 6 } });
    }) as typeof fetch;

  it('names the model and times one short prompt', async () => {
    const r = await sw(['model', 'check'], { fetch: server('{"ok": true}') });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /^The local model answers: models\/fake-4b\.gguf at http:\/\/127\.0\.0\.1:8731\/v1\nA test prompt came back as the JSON it asked for in \d+\.\d s \(31 tokens in, 6 out\)\.\n$/,
    );
    const json = JSON.parse((await sw(['model', 'check', '--json'], { fetch: server('{"ok": true}') })).out);
    expect(json).toMatchObject({ engine: 'local', model: 'models/fake-4b.gguf', ok: true, tokensIn: 31, tokensOut: 6 });
  });

  it('says how to start a server when none answers', async () => {
    const r = await sw(['model', 'check'], { fetch: server('', true) });
    expect(r.code).toBe(2);
    expect(r.err).toContain('No model server answers at http://127.0.0.1:8731/v1.');
  });

  it('fails when the answer is not the JSON it asked for', async () => {
    expect((await sw(['model', 'check'], { fetch: server('Sure! Here you go.') })).err).toContain("The model's answer for the model check is not JSON");
    const wrong = await sw(['model', 'check'], { fetch: server('{"ok": "yes"}') });
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain('not the object it asked for');
  });
});

describe('skeinwise model serve', () => {
  it('prints the llama-server command on the port in the settings', async () => {
    expect((await sw(['model', 'serve'])).err).toContain(`isn't in ${join(home, 'models')} yet. Fetch it with: skeinwise model fetch`);
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(target(), 'weights');
    setConfigValue(home, 'localUrl', 'http://localhost:9100/v1');
    const r = await sw(['model', 'serve']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `llama-server -m ${target()} --host 127.0.0.1 --port 9100 -c 32768 -ngl 99 --jinja\n\nRun it in its own terminal, or let Skeinwise run it: skeinwise model serve --run\n`,
    );
    expect(serveCommand('/m/my model.gguf', 'http://127.0.0.1:8731/v1').slice(0, 3)).toEqual(['llama-server', '-m', '/m/my model.gguf']);
    expect(() => serveCommand('/m.gguf', 'https://api.example.com/v1')).toThrow(/not on this computer/);
  });

  it('runs llama-server with --run, or says how to install it', async () => {
    const own = join(dir, 'mine.gguf');
    writeFileSync(own, 'weights');
    const missing = await sw(['model', 'serve', own, '--run']);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('llama-server is not on your PATH. Install llama.cpp (on macOS: brew install llama.cpp)');

    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'args.txt');
    writeFileSync(join(bin, 'llama-server'), `#!/bin/sh\necho "$@" > '${log}'\nexit 3\n`);
    chmodSync(join(bin, 'llama-server'), 0o755);
    const r = await sw(['model', 'serve', own, '--run'], { env: { SKEINWISE_HOME: home, PATH: bin } });
    expect(r.code).toBe(3);
    expect(r.err).toContain('The model answers at http://127.0.0.1:8731/v1 once it has loaded.');
    expect(readFileSync(log, 'utf8')).toBe(`-m ${own} --host 127.0.0.1 --port 8731 -c 32768 -ngl 99 --jinja\n`);
  });
});

it('sizes read the way the download prompt shows them', () => {
  expect([gigabytes(2_497_280_256), gigabytes(120_000_000), gigabytes(300_000), gigabytes(12)]).toEqual(['2.5 GB', '120 MB', '300 kB', '1 kB']);
});

it('model with no chore lists the three', async () => {
  const r = await sw(['model']);
  expect(r.code).toBe(2);
  expect(r.err).toContain('Give one of: skeinwise model check, skeinwise model fetch, skeinwise model serve');
});
