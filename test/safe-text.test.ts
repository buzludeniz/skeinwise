import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.ts';
import { isBidiControl, safeBlock, safeIo, safeJson, safeLine } from '../src/safe-text.ts';

const ESC = '\u001b';
const BEL = '\u0007';
const ch = (c: number) => String.fromCharCode(c);
const range = (low: number, high: number) => Array.from({ length: high - low + 1 }, (_, k) => low + k);

/** Anything a terminal could act on. Line feed and tab are allowed only where `allowBreaks` says so. */
function unsafeAt(text: string, allowBreaks: boolean): number {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (allowBreaks && (c === 0x0a || c === 0x09)) continue;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || isBidiControl(c)) return i;
  }
  return -1;
}

describe('safeBlock', () => {
  it('leaves plain text as it is, in any script', () => {
    const text = 'Plotline: SQLite, not Postgres.\n\tWaiting list → 120 people. 日本語 ✓ 🧶 שלום‏ عربى؜';
    expect(safeBlock(text)).toBe(text);
  });

  it('drops every C0 control except line feed and tab', () => {
    for (const c of range(0x00, 0x1f)) {
      const got = safeBlock(`a${ch(c)}b`);
      if (c === 0x0a || c === 0x09) expect(got).toBe(`a${ch(c)}b`);
      else if (c === 0x0d) expect(got).toBe('a\nb');
      else if (c === 0x1b) expect(got).toBe('a'); // ESC b is a two-byte escape sequence, so b goes with it
      else expect(got, `U+${c.toString(16)}`).toBe('ab');
    }
  });

  it('turns a carriage return into one line break, never a return over the line', () => {
    expect(safeBlock('one\r\ntwo\rthree\r')).toBe('one\ntwo\nthree\n');
  });

  it('drops DEL and every C1 control', () => {
    for (const c of range(0x7f, 0x9f)) expect(unsafeAt(safeBlock(`a${ch(c)}b`), true), `U+${c.toString(16)}`).toBe(-1);
    for (const c of [0x7f, 0x80, 0x85, 0x8d, 0x9a, 0x9c]) expect(safeBlock(`a${ch(c)}b`)).toBe('ab');
  });

  it('drops the bidi embeddings, overrides and isolates, and keeps the marks', () => {
    const controls = [...range(0x202a, 0x202e), ...range(0x2066, 0x2069)];
    for (const c of controls) expect(safeBlock(`a${ch(c)}b`), `U+${c.toString(16)}`).toBe('ab');
    for (const c of [0x200e, 0x200f, 0x061c]) expect(safeBlock(`a${ch(c)}b`)).toBe(`a${ch(c)}b`);
    // The Trojan Source shape: an override that would show "admin" checks in the wrong order.
    expect(safeBlock('if (role == "user‮ ⁦// admin⁩ ⁦")')).toBe('if (role == "user // admin ")');
  });

  it('drops CSI sequences whole, which also brings hidden text back into view', () => {
    expect(safeBlock(`car.${ESC}[8m hidden text${ESC}[0m`)).toBe('car. hidden text');
    expect(safeBlock(`${ESC}[2J${ESC}[1;1Hgarden`)).toBe('garden');
    expect(safeBlock(`${ESC}[?1049h${ESC}[38;2;255;0;0mred${ESC}[m`)).toBe('red');
    expect(safeBlock(`\u009b2J\u009b8mtext`)).toBe('text');
  });

  it('drops OSC strings whole: clipboard writes, window titles and hidden link targets', () => {
    expect(safeBlock(`a ${ESC}]52;c;ZWNobyBwd25lZA==${BEL}b`)).toBe('a b');
    expect(safeBlock(`${ESC}]0;window title set by import${BEL}after`)).toBe('after');
    expect(safeBlock(`${ESC}]8;;https://attacker.example/${BEL}harmless link${ESC}]8;;${BEL}.`)).toBe('harmless link.');
    expect(safeBlock(`${ESC}]8;;https://attacker.example/${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link');
    expect(safeBlock(`\u009d52;c;cHduZWQ=\u009cafter`)).toBe('after');
    expect(safeBlock(`\u009d0;title${BEL}after`)).toBe('after');
  });

  it('drops DCS, SOS, PM and APC strings whole', () => {
    for (const intro of ['P', 'X', '^', '_']) expect(safeBlock(`a${ESC}${intro}payload${ESC}\\b`)).toBe('ab');
    for (const intro of [0x90, 0x98, 0x9e, 0x9f]) expect(safeBlock(`a${ch(intro)}payload\u009cb`)).toBe('ab');
  });

  it('drops the short escape sequences', () => {
    expect(safeBlock(`a${ESC}(Bb`)).toBe('ab');
    expect(safeBlock(`a${ESC}7b${ESC}8c`)).toBe('abc');
    expect(safeBlock(`a${ESC}cb`)).toBe('ab'); // full reset
    expect(safeBlock(`a${ESC}\\b`)).toBe('ab'); // a stray terminator
    expect(safeBlock(`a${ESC}`)).toBe('a');
    expect(safeBlock(`a${ESC}éb`)).toBe('aéb');
  });

  it('keeps the text of a string that never ends, so nothing vanishes from view', () => {
    expect(safeBlock(`a${ESC}]0;still visible`)).toBe('a0;still visible');
    expect(safeBlock(`${ESC}]52;c;abc${ESC}[8mword`)).toBe('52;c;abcword');
    expect(safeBlock(`${ESC}Pkept\u0018 too`)).toBe('kept too');
  });

  // Linear, not quadratic: a quadratic pass over 200,000 characters takes seconds. The best of five passes keeps a
  // busy machine or a slow CI runner from failing it (it failed at 50 ms on one pass under load, Nov 25).
  it('cleans in one linear pass: 200,000 hostile characters, the best of five passes under 250 ms each', () => {
    const hostile = [
      `${ESC}]`.repeat(100_000),
      `${ESC}[${'1;'.repeat(100_000)}`,
      `\u009d${'x'.repeat(199_999)}`,
      `${ESC}P${'y'.repeat(99_998)}${ESC}]`.repeat(2),
      `${ESC}(`.repeat(100_000),
      '‮\u0000'.repeat(100_000),
    ];
    for (const text of hostile) {
      safeBlock(text); // warm up
      let best = Infinity;
      let got = '';
      for (let pass = 0; pass < 5; pass++) {
        const start = performance.now();
        got = safeBlock(text);
        best = Math.min(best, performance.now() - start);
      }
      expect(best).toBeLessThan(250);
      expect(unsafeAt(got, true)).toBe(-1);
    }
  });

  it('never lets a control through, and a second pass changes nothing (seeded fuzz)', () => {
    let seed = 20261125;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    const alphabet = [...range(0x00, 0x7f), ...range(0x80, 0x9f), 0x202a, 0x202e, 0x2066, 0x2069, 0x200f, 0xe9, 0x65e5];
    for (let n = 0; n < 2000; n++) {
      const text = Array.from({ length: next() % 40 }, () => ch(alphabet[next() % alphabet.length]!)).join('');
      const block = safeBlock(text);
      const line = safeLine(text);
      expect(unsafeAt(block, true), JSON.stringify(text)).toBe(-1);
      expect(unsafeAt(line, false), JSON.stringify(text)).toBe(-1);
      expect(safeBlock(block)).toBe(block);
      expect(safeLine(line)).toBe(line);
    }
  });
});

describe('safeLine', () => {
  it('cleans as safeBlock does, and puts line breaks and tabs on one line', () => {
    expect(safeLine('a\nb\tc\r\nd\re')).toBe('a b c d e');
    expect(safeLine(`${ESC}]0;title-from-filename${BEL}${ESC}[2Jgarden`)).toBe('garden');
    // A title can't forge a second entry header on the next line.
    expect(safeLine('Plan\n#999  2020-01-01  you · Approved')).toBe('Plan #999  2020-01-01  you · Approved');
  });
});

describe('safeJson', () => {
  it('escapes DEL, C1 and bidi controls, and parses back to the same value', () => {
    const value = { title: `a‮b\u0085c\u007f${ESC}]52;c;x${BEL}`, list: ['⁦', 1, null] };
    const text = safeJson(value, 2);
    expect(unsafeAt(text, true)).toBe(-1);
    expect(text).toContain('\\u202e');
    expect(text).toContain('\\u001b');
    expect(JSON.parse(text)).toEqual(value);
    expect(safeJson({ a: 'plain' })).toBe('{"a":"plain"}');
  });

  it('refuses a value JSON has no text for', () => {
    expect(() => safeJson(undefined)).toThrow(TypeError);
  });
});

describe('safeIo', () => {
  it('cleans both printers and keeps the rest of the io', () => {
    let out = '';
    let err = '';
    const env = { SKEINWISE_HOME: '/nowhere' };
    const io = safeIo({ out: (t: string) => void (out += t), err: (t: string) => void (err += t), env });
    io.out(`a${ESC}[8mb\n`);
    io.err(`c${ESC}]52;c;x${BEL}d\n`);
    expect(out).toBe('ab\n');
    expect(err).toBe('cd\n');
    expect(io.env).toBe(env);
  });
});

// PoC 08 (M5): an imported chat and a vault file name carry OSC 52, OSC 8, OSC 0, CSI 8m and CSI 2J. Before the fix
// `show`, `search` and `thread` wrote 6 ESC bytes each. Through an io wrapped in safeIo, as `src/cli.ts` wraps it
// at `main`, none reach the screen and the hidden words do.
describe('PoC 08: terminal escapes from imported text', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-safe-text-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function cli(...argv: string[]) {
    let out = '';
    let err = '';
    const io = { out: (t: string) => void (out += t), err: (t: string) => void (err += t), env: { SKEINWISE_HOME: join(dir, 'home') } };
    const code = await main(argv, safeIo(io));
    return { code, out, err };
  }

  it('prints no escape byte from show, search or thread', async () => {
    const body =
      `I promise to give Mallory my car.${ESC}[8m hidden text${ESC}[0m ${ESC}]52;c;ZWNobyBwd25lZA==${BEL}` +
      `${ESC}]8;;https://attacker.example/${BEL}harmless link${ESC}]8;;${BEL} ${ESC}]0;window title set by import${BEL}`;
    const t = Date.parse('2014-05-01T09:00:00Z') / 1000;
    const chats = join(dir, 'export');
    mkdirSync(chats);
    writeFileSync(
      join(chats, 'conversations.json'),
      JSON.stringify([
        {
          id: 'poc-08',
          title: `Old promise${ESC}]0;chat title${BEL}`,
          create_time: t,
          current_node: 'm0',
          mapping: { m0: { id: 'm0', parent: null, message: { id: 'm0', author: { role: 'user' }, create_time: t, content: { content_type: 'text', parts: [body] } } } },
        },
      ]),
    );

    expect((await cli('import', chats)).code).toBe(0);
    const [hit] = JSON.parse((await cli('search', 'Mallory', '--json')).out) as { id: number; threadId: number }[];

    const runs = {
      show: await cli('show', String(hit!.id)),
      search: await cli('search', 'Mallory'),
      thread: await cli('thread', String(hit!.threadId)),
    };
    for (const [name, r] of Object.entries(runs)) {
      expect(r.code, name).toBe(0);
      expect([...r.out].filter((c) => c === ESC).length, name).toBe(0);
      expect(unsafeAt(r.out, true), name).toBe(-1);
    }
    expect(runs.show.out).toContain('car. hidden text');
    expect(runs.show.out).toContain('harmless link');
    expect(runs.show.out).not.toContain('attacker.example');
  });

  // NTFS forbids control characters in file names, so no such file can exist on Windows.
  it.skipIf(process.platform === 'win32')('prints no escape byte from a title taken from a file name', async () => {
    const vault = join(dir, '08_vault');
    mkdirSync(vault);
    writeFileSync(join(vault, `${ESC}]0;title-from-filename${BEL}${ESC}[2Jgarden.md`), 'plain body about gardening');

    expect((await cli('import', vault)).code).toBe(0);
    const title = await cli('search', 'gardening');
    expect(title.code).toBe(0);
    expect([...title.out].filter((c) => c === ESC).length).toBe(0);
    expect(unsafeAt(title.out, true)).toBe(-1);
    expect(title.out).toMatch(/· garden\n/);
  });
});
