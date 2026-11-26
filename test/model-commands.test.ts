import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Io, main } from '../src/cli.ts';
import { loadConfig, setConfigValue } from '../src/config.ts';
import { commandLine, findLlamaServer, gigabytes, LOCKED_FLAGS, SUGGESTED, serveCommand } from '../src/model-commands.ts';

// `skeinwise model check|trust|fetch|serve`, against a fake model server, a fake Hugging Face and a fake llama-server.
// Every key and token here is made up, and built so that nothing in this file looks like a real one.

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

// A made-up model file: 300 kB of bytes that are not all the same, pinned in place of the real one for these tests.
const WEIGHTS = new Uint8Array(300_000).map((_, i) => (i * 31 + (i >> 8)) % 251);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const SHA = sha(WEIGHTS);
const REVISION = 'c0ffee'.padEnd(40, '0');
const REAL = { ...SUGGESTED };
beforeEach(() => Object.assign(SUGGESTED, { revision: REVISION, size: WEIGHTS.length, sha256: SHA }));
afterEach(() => Object.assign(SUGGESTED, REAL));

interface HubOpts {
  bytes?: Uint8Array;
  ignoreRange?: boolean;
  /** Send this many bytes, then break the connection. */
  breakAt?: number;
}

/** A fake Hugging Face that serves the file at the pinned revision, with range requests. */
function fakeHub(opts: HubOpts = {}) {
  const requests: { url: string; range: string | null }[] = [];
  const bytes = opts.bytes ?? WEIGHTS;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const range = (init?.headers as Record<string, string> | undefined)?.range ?? null;
    requests.push({ url, range });
    if (url === `https://huggingface.co/${SUGGESTED.repo}/resolve/${REVISION}/${SUGGESTED.file}`) {
      const from = range && !opts.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      const body = bytes.slice(from);
      if (opts.breakAt === undefined) return new Response(body, { status: from ? 206 : 200 });
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent) return c.error(new TypeError('terminated'));
          sent = true;
          c.enqueue(body.slice(0, opts.breakAt));
        },
      });
      return new Response(stream, { status: from ? 206 : 200 });
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
    expect(r.out).toContain(`Qwen3-4B, quantised to Q4_K_M: 300 kB\n  from https://huggingface.co/${SUGGESTED.repo}/resolve/${REVISION}/${SUGGESTED.file}\n  to   ${target()}\n`);
    expect(r.err).toContain('Add --yes to download it.');
    expect(hub.requests).toEqual([]);

    const no = await sw(['model', 'fetch'], { fetch: hub.fetch, ask: async () => 'n' });
    expect(no.code).toBe(0);
    expect(no.out).toMatch(/Nothing was downloaded\.\n$/);
    expect(hub.requests).toEqual([]);
    expect(existsSync(target())).toBe(false);
  });

  it('downloads on a yes, checks the pinned sha256, and checks it again the second time', async () => {
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
    expect(sha(readFileSync(target()))).toBe(SHA);
    expect(existsSync(`${target()}.part`)).toBe(false);

    const again = await sw(['model', 'fetch', '--yes'], { fetch: hub.fetch });
    expect(again.out).toContain(`${SUGGESTED.file} is already in ${join(home, 'models')} (300 kB, sha256 checked)`);
    expect(hub.downloads()).toHaveLength(1);
  });

  // Security audit M14 (poc_download case 1, supply/08 case 1): the hash came from the same /tree/main as the file.
  it('takes the hash from the pin, never from the source, and deletes a swapped file', async () => {
    const swapped = new TextEncoder().encode('GGUF\u0003\u0000\u0000\u0000 not the pinned weights');
    for (const bytes of [swapped, WEIGHTS.map((b) => b ^ 1), new Uint8Array(WEIGHTS.length + 10)]) {
      const hub = fakeHub({ bytes });
      const r = await sw(['model', 'fetch', '--yes'], { fetch: hub.fetch });
      expect(r.code).toBe(1);
      expect(r.err).toContain('sha256 mismatch');
      expect(r.err).toContain(`isn't the ${SUGGESTED.file} Skeinwise pins (300000 bytes, sha256 ${SHA}). It was deleted; nothing was saved.`);
      expect(hub.requests.map((q) => q.url).filter((u) => !u.includes(`/resolve/${REVISION}/`))).toEqual([]);
      expect(existsSync(target())).toBe(false);
      expect(existsSync(`${target()}.part`)).toBe(false);
    }
  });

  // Security audit L13 (poc_download case 2): a file of the listed size was trusted, and --json showed the listed hash.
  it('hashes a file already there, and replaces one that is not the pinned file', async () => {
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(target(), WEIGHTS.map((b) => b ^ 0x41));
    const hub = fakeHub();
    const shown = await sw(['model', 'fetch'], { fetch: hub.fetch });
    expect(shown.out).toContain(`The ${SUGGESTED.file} there isn't the one Skeinwise pins (its size or sha256 differs); the download replaces it.`);

    const r = await sw(['model', 'fetch', '--yes', '--json'], { fetch: hub.fetch });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ path: target(), size: WEIGHTS.length, sha256: SHA, downloaded: true });
    expect(sha(readFileSync(target()))).toBe(SHA);
    expect(hub.downloads()).toHaveLength(1);
  });

  it('keeps a download whose connection broke, and fetches only the rest next time', async () => {
    const cut = fakeHub({ breakAt: 120_000 });
    const first = await sw(['model', 'fetch', '--yes'], { fetch: cut.fetch });
    expect(first.code).toBe(1);
    expect(first.err).toContain('The download broke off at 120000 of 300000 bytes (terminated). Run skeinwise model fetch again to fetch the rest.');
    expect(readFileSync(`${target()}.part`)).toHaveLength(120_000);

    const hub = fakeHub();
    const r = await sw(['model', 'fetch', '--yes'], { fetch: hub.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toContain('120 kB came down before; the rest follows.');
    expect(hub.downloads()).toEqual([expect.objectContaining({ range: 'bytes=120000-' })]);
    expect(sha(readFileSync(target()))).toBe(SHA);
  });

  it('deletes a planted partial download once the rest shows it is not the pinned file', async () => {
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(`${target()}.part`, new Uint8Array(1000).fill(0x41));
    const r = await sw(['model', 'fetch', '--yes'], { fetch: fakeHub().fetch });
    expect(r.code).toBe(1);
    expect(r.err).toContain('sha256 mismatch');
    expect(existsSync(`${target()}.part`)).toBe(false);
    expect((await sw(['model', 'fetch', '--yes'], { fetch: fakeHub().fetch })).code).toBe(0);
    expect(sha(readFileSync(target()))).toBe(SHA);
  });

  it('starts over when the server ignores the range', async () => {
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(`${target()}.part`, WEIGHTS.slice(0, 50_000));
    const hub = fakeHub({ ignoreRange: true });
    expect((await sw(['model', 'fetch', '--yes'], { fetch: hub.fetch })).code).toBe(0);
    expect(sha(readFileSync(target()))).toBe(SHA);
  });

  it('pins the real model by commit, size and sha256', () => {
    expect(REAL).toMatchObject({ repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', size: 2_497_280_256 });
    expect(REAL.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(REAL.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('skeinwise model check', () => {
  const server = (content: string, down = false, seen: { url: string; headers: Record<string, string> }[] = []) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
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
    expect(JSON.parse((await sw(['runs', '--json'])).out)).toEqual([]);
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

  // Security audit M11 (supply/07 part A, the wire proof of concept part 3): the check sent the key to any host, and
  // recorded no run.
  describe('of the outside model', () => {
    const key = ['made', 'up', 'remote', 'key'].join('-');
    const env = () => ({ SKEINWISE_HOME: home, PATH: '', SKEINWISE_TEST_KEY: key });
    beforeEach(() => {
      setConfigValue(home, 'remoteUrl', 'https://models.example.net/v1');
      setConfigValue(home, 'remoteModel', 'big-1');
      setConfigValue(home, 'apiKeyEnv', 'SKEINWISE_TEST_KEY');
    });

    it('sends nothing to a host that was never confirmed, and records nothing', async () => {
      const seen: { url: string; headers: Record<string, string> }[] = [];
      const r = await sw(['model', 'check', '--engine', 'remote'], { env: env(), fetch: server('{"ok": true}', false, seen) });
      expect(r.code).toBe(2);
      expect(r.err).toContain("only goes to hosts you confirmed, and models.example.net isn't one");
      expect(r.err).toContain('skeinwise model trust models.example.net');
      expect(seen).toEqual([]);
      expect(JSON.parse((await sw(['runs', '--json'])).out)).toEqual([]);
    });

    it('records the check as a run once the host is confirmed, inside the budget', async () => {
      expect((await sw(['model', 'trust', '--yes'])).code).toBe(0);
      const seen: { url: string; headers: Record<string, string> }[] = [];
      const r = await sw(['model', 'check', '--engine', 'remote'], { env: env(), fetch: server('{"ok": true}', false, seen) });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/^The outside model answers: big-1 at https:\/\/models\.example\.net\/v1\n[\s\S]*Recorded as run \d+\.\n$/);
      expect(seen.map((s) => [s.url, s.headers.authorization])).toEqual([['https://models.example.net/v1/chat/completions', `Bearer ${key}`]]);
      const runs = JSON.parse((await sw(['runs', '--json'])).out) as Record<string, unknown>[];
      expect(runs).toEqual([expect.objectContaining({ task: 'ask', engine: 'remote', model: 'big-1', status: 'done', message: 'model check', tokensIn: 31, tokensOut: 6 })]);

      setConfigValue(home, 'budget', '50');
      const over = await sw(['model', 'check', '--engine', 'remote'], { env: env(), fetch: server('{"ok": true}', false, seen) });
      expect(over.code).toBe(2);
      expect(over.err).toMatch(/model check needs about \d+ tokens, and 13 of the outside model's monthly budget of 50 is left/);
      expect(seen).toHaveLength(1);
    });

    it('records a failed check with what it spent', async () => {
      await sw(['model', 'trust', '--yes']);
      const r = await sw(['model', 'check', '--engine', 'remote'], { env: env(), fetch: server('Sure! Here you go.') });
      expect(r.code).toBe(1);
      const runs = JSON.parse((await sw(['runs', '--json'])).out) as Record<string, unknown>[];
      expect(runs).toEqual([expect.objectContaining({ status: 'failed', tokensIn: 31, tokensOut: 6 })]);
      expect(String(runs[0]!.message)).not.toContain(key);
    });
  });
});

describe('skeinwise model trust', () => {
  it("confirms remoteUrl's host, or the one given, after asking", async () => {
    expect((await sw(['model', 'trust'])).err).toContain('Name the host to confirm, or set the outside model first');
    setConfigValue(home, 'remoteUrl', 'https://models.example.net/v1');
    setConfigValue(home, 'apiKeyEnv', 'SKEINWISE_TEST_KEY');

    const asked = await sw(['model', 'trust']);
    expect(asked.code).toBe(2);
    expect(asked.out).toContain('Requests to the outside model at models.example.net carry the key in SKEINWISE_TEST_KEY');
    expect(asked.err).toContain('Add --yes to confirm models.example.net.');
    const no = await sw(['model', 'trust'], { ask: async () => 'n' });
    expect(no.out).toContain('Nothing was confirmed.');
    expect(loadConfig(home).remoteHosts).toEqual([]);

    const yes = await sw(['model', 'trust'], { ask: async () => 'y' });
    expect(yes.out).toContain('Confirmed models.example.net.');
    const other = JSON.parse((await sw(['model', 'trust', 'https://Models.Example.net:8443/v1', '--yes', '--json'])).out);
    expect(other).toEqual({ host: 'models.example.net:8443', confirmed: true, remoteHosts: ['models.example.net', 'models.example.net:8443'] });
    expect((await sw(['model', 'trust', 'models.example.net'])).out).toBe('models.example.net is already confirmed.\n');
    expect((await sw(['model', 'trust', 'evil.example/path', '--yes'])).err).toContain('a list of hosts');
  });
});

describe('skeinwise model serve', () => {
  const keyFile = () => join(home, 'models', '.key');

  it('prints the locked llama-server command on the port in the settings, and makes the key', async () => {
    expect((await sw(['model', 'serve'])).err).toContain(`isn't in ${join(home, 'models')} yet. Fetch it with: skeinwise model fetch`);
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(target(), WEIGHTS);
    setConfigValue(home, 'localUrl', 'http://localhost:9100/v1');
    const r = await sw(['model', 'serve']);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `llama-server -m ${target()} --alias Qwen3-4B-Q4_K_M --host 127.0.0.1 --port 9100 -c 32768 -ngl 99 --jinja ` +
        `--api-key-file ${keyFile()} --no-webui --no-slots --cors-origins http://127.0.0.1:9100 --no-cors-credentials\n\n` +
        `It answers only requests that carry the key in ${keyFile()}, which Skeinwise sends.\n` +
        'Run it in its own terminal, or let Skeinwise run it: skeinwise model serve --run\n',
    );
    const key = readFileSync(keyFile(), 'utf8').trim();
    expect(key.length).toBeGreaterThanOrEqual(40);
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(r.out).not.toContain(key);
    // The key is made once: a second serve keeps it, so a server already running still takes it.
    await sw(['model', 'serve']);
    expect(readFileSync(keyFile(), 'utf8').trim()).toBe(key);

    expect(serveCommand('/m/my model.gguf', 'http://127.0.0.1:8731/v1', '/k').slice(0, 5)).toEqual(['llama-server', '-m', '/m/my model.gguf', '--alias', 'my model']);
    expect(() => serveCommand('/m.gguf', 'https://api.example.com/v1', '/k')).toThrow(/not on this computer/);
  });

  it('quotes the printed command for the platform: double quotes on Windows, single quotes elsewhere', () => {
    const win = ['C:\\Program Files\\llama\\llama-server.exe', '-m', 'C:\\Users\\RUNNER~1\\my model.gguf', '--alias', 'it\'s "q"', '--api-key-file', 'C:\\key dir\\'];
    expect(commandLine(win, 'win32')).toBe(
      '"C:\\Program Files\\llama\\llama-server.exe" -m "C:\\Users\\RUNNER~1\\my model.gguf" --alias "it\'s \\"q\\"" --api-key-file "C:\\key dir\\\\"',
    );
    expect(commandLine(['C:\\llama\\llama-server.exe', '--port', '8731', '--cors-origins', 'http://127.0.0.1:8731'], 'win32')).toBe(
      'C:\\llama\\llama-server.exe --port 8731 --cors-origins http://127.0.0.1:8731',
    );
    expect(commandLine(['/opt/llama-server', '-m', '/m/my model.gguf', '--alias', "it's", '--api-key-file', 'C:\\k'], 'darwin')).toBe(
      "/opt/llama-server -m '/m/my model.gguf' --alias 'it'\\''s' --api-key-file 'C:\\k'",
    );
  });

  it('looks for llama-server.exe on a Windows PATH, split by ";"', () => {
    const [a, b] = [join(dir, 'a'), join(dir, 'b')];
    for (const [where, name] of [[a, 'llama-server'], [b, 'llama-server.exe']] as const) {
      mkdirSync(where);
      writeFileSync(join(where, name), '');
      chmodSync(join(where, name), 0o755);
    }
    expect(findLlamaServer(`${a};${b}`, 'win32')).toBe(join(b, 'llama-server.exe'));
    expect(findLlamaServer(a, 'win32')).toBeNull();
  });

  // A Windows PATH entry's drive colon would split a ":" PATH apart.
  it.skipIf(process.platform === 'win32')('looks for llama-server on a POSIX PATH, split by ":"', () => {
    const [a, b] = [join(dir, 'a'), join(dir, 'b')];
    for (const [where, name] of [[a, 'llama-server.exe'], [b, 'llama-server']] as const) {
      mkdirSync(where);
      writeFileSync(join(where, name), '');
      chmodSync(join(where, name), 0o755);
    }
    expect(findLlamaServer(`${a}:${b}`, 'linux')).toBe(join(b, 'llama-server'));
    expect(findLlamaServer(a, 'darwin')).toBeNull();
  });

  // Security audit M1 and L15 (web/05, poc_download case 4): llama-server ran open to web pages, was found on PATH on
  // every run, and got the whole environment.
  describe('--run', () => {
    let own: string;
    const log = () => join(dir, 'args.txt');
    /** A fake llama-server: lists `flags` for --help; otherwise writes its arguments and environment, and exits 3. */
    function fakeServer(where: string, flags = LOCKED_FLAGS): string {
      mkdirSync(where, { recursive: true });
      const file = join(where, 'llama-server');
      writeFileSync(
        file,
        `#!/bin/sh\nif [ "$1" = --help ]; then echo '${flags.join('\n')}'; exit 0; fi\n{ echo "$@"; /usr/bin/env; } > '${log()}'\nexit 3\n`,
      );
      chmodSync(file, 0o755);
      return file;
    }
    beforeEach(() => {
      own = join(dir, 'mine.gguf');
      writeFileSync(own, 'weights');
    });

    it('says how to install llama-server when there is none', async () => {
      const missing = await sw(['model', 'serve', own, '--run']);
      expect(missing.code).toBe(2);
      expect(missing.err).toContain('llama-server is not on your PATH. Install llama.cpp (on macOS: brew install llama.cpp)');
    });

    // The fake llama-server is a shell script, and Windows looks for llama-server.exe; the lookup is tested above.
    it.skipIf(process.platform === 'win32')('runs it locked, with none of your keys, and keeps the program it found', async () => {
      const bin = fakeServer(join(dir, 'bin'));
      const token = ['made', 'up', 'token'].join('_');
      const r = await sw(['model', 'serve', own, '--run'], {
        env: { SKEINWISE_HOME: home, PATH: join(dir, 'bin'), HOME: dir, LANG: 'en_US.UTF-8', GITHUB_TOKEN: token, EXAMPLE_API_KEY: token, SKEINWISE_TEST_KEY: token },
      });
      expect(r.code).toBe(3);
      expect(r.err).toContain(`Using ${bin}, found on your PATH and saved as llamaServer.`);
      expect(r.err).toContain('The model answers at http://127.0.0.1:8731/v1 once it has loaded.');
      const [args, ...envLines] = readFileSync(log(), 'utf8').trim().split('\n');
      expect(args).toBe(
        `-m ${own} --alias mine --host 127.0.0.1 --port 8731 -c 32768 -ngl 99 --jinja --api-key-file ${keyFile()} ` +
          '--no-webui --no-slots --cors-origins http://127.0.0.1:8731 --no-cors-credentials',
      );
      expect(envLines.join('\n')).not.toContain(token);
      expect(envLines).toContain('LANG=en_US.UTF-8');
      expect(envLines).toContain(`HOME=${dir}`);
      expect(loadConfig(home).llamaServer).toBe(bin);

      // A program put earlier on PATH later is not run in its place.
      const planted = join(dir, 'planted');
      mkdirSync(planted);
      writeFileSync(join(planted, 'llama-server'), `#!/bin/sh\necho planted > '${join(dir, 'planted.txt')}'\n`);
      chmodSync(join(planted, 'llama-server'), 0o755);
      expect((await sw(['model', 'serve', own, '--run'], { env: { SKEINWISE_HOME: home, PATH: `${planted}:${join(dir, 'bin')}` } })).code).toBe(3);
      expect(existsSync(join(dir, 'planted.txt'))).toBe(false);
    });

    // E1 (Deniz, Nov 25): fetch checked the file once, but anything that could write to models/ afterwards could swap it.
    it('re-checks the file under the pinned name against the pin, printed or run', async () => {
      fakeServer(join(dir, 'bin'));
      const env = { SKEINWISE_HOME: home, PATH: join(dir, 'bin') };
      mkdirSync(join(home, 'models'), { recursive: true });
      const swapped = WEIGHTS.slice();
      swapped[150_000] = (swapped[150_000]! + 1) % 251;
      for (const planted of [WEIGHTS.slice(0, 1000), swapped]) {
        writeFileSync(target(), planted);
        for (const argv of [['model', 'serve'], ['model', 'serve', '--run']]) {
          const r = await sw(argv, { env });
          expect(r.code).toBe(1);
          expect(r.err).toContain(
            `${target()} isn't the ${SUGGESTED.file} Skeinwise pins (its size or sha256 differs), so Skeinwise won't start it. ` +
              'Download it again with: skeinwise model fetch',
          );
          expect(r.out).toBe('');
        }
      }
      expect(existsSync(log())).toBe(false);
    });

    // Runs the shell-script fake; see above.
    it.skipIf(process.platform === 'win32')('runs the file under the pinned name once it matches, and leaves a .gguf of yours alone', async () => {
      fakeServer(join(dir, 'bin'));
      const env = { SKEINWISE_HOME: home, PATH: join(dir, 'bin') };
      mkdirSync(join(home, 'models'), { recursive: true });
      writeFileSync(target(), WEIGHTS);
      const pinned = await sw(['model', 'serve', '--run'], { env });
      expect(pinned.code).toBe(3);
      expect(pinned.err).toContain(`Checking the sha256 of ${target()}...`);
      expect(readFileSync(log(), 'utf8')).toContain(`-m ${target()} `);

      // Your own file isn't held to the pin: `own` is seven bytes of 'weights'.
      expect((await sw(['model', 'serve', own, '--run'], { env })).code).toBe(3);
    });

    // Runs the shell-script fake for its --help; see above.
    it.skipIf(process.platform === 'win32')('refuses a llama-server that lacks a flag that keeps it closed', async () => {
      fakeServer(join(dir, 'old'), LOCKED_FLAGS.filter((f) => f !== '--no-webui'));
      const old = await sw(['model', 'serve', own, '--run'], { env: { SKEINWISE_HOME: home, PATH: join(dir, 'old') } });
      expect(old.code).toBe(2);
      expect(old.err).toContain("doesn't list --no-webui in its --help, so Skeinwise can't start it closed to web pages");
      expect(existsSync(log())).toBe(false);
      expect(loadConfig(home).llamaServer).toBe('');
    });

    it('refuses a saved llama-server that is gone', async () => {
      setConfigValue(home, 'llamaServer', join(dir, 'gone', 'llama-server'));
      const gone = await sw(['model', 'serve', own, '--run']);
      expect(gone.code).toBe(2);
      expect(gone.err).toContain("isn't a program you can run");
    });
  });
});

it('sizes read the way the download prompt shows them', () => {
  expect([gigabytes(2_497_280_256), gigabytes(120_000_000), gigabytes(300_000), gigabytes(12)]).toEqual(['2.5 GB', '120 MB', '300 kB', '1 kB']);
});

it('model with no chore lists them', async () => {
  const r = await sw(['model']);
  expect(r.code).toBe(2);
  expect(r.err).toContain('Give one of: skeinwise model check, skeinwise model fetch, skeinwise model serve, skeinwise model trust <host>');
});
