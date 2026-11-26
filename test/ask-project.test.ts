import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';

// `ask --project`: ask keeps to coding sessions run in one folder, the way search does (SearchOptions.project).
describe('ask --project', () => {
  let dir: string;

  async function cli(...argv: string[]) {
    let out = '';
    let err = '';
    const code = await main(argv, { out: (t) => (out += t), err: (t) => (err += t), env: { SKEINWISE_HOME: join(dir, 'home') } });
    return { code, out, err };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'skeinwise-ask-project-'));
    const projects = join(dir, 'claude-code', 'projects');
    const sessions: [string, string, string, string][] = [
      ['s-plot', '/home/mara/code/plotline', '2026-03-01T09:00:00.000Z', 'Reminders go out twice in plotline.'],
      ['s-plot-2', '/home/mara/code/plotline/web', '2026-04-01T09:00:00.000Z', 'Decided: reminders go out once, at nine.'],
      ['s-ledger', '/home/mara/code/ledger', '2026-02-01T09:00:00.000Z', 'Decided: reminders for invoices go out weekly.'],
    ];
    for (const [id, cwd, timestamp, prompt] of sessions) {
      const folder = join(projects, cwd.replaceAll('/', '-'));
      mkdirSync(folder, { recursive: true });
      const line = { type: 'user', uuid: `${id}-u1`, sessionId: id, cwd, gitBranch: 'main', timestamp, message: { role: 'user', content: prompt } };
      writeFileSync(join(folder, `${id}.jsonl`), `${JSON.stringify(line)}\n`);
    }
    expect((await cli('import', join(dir, 'claude-code'))).code).toBe(0);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const asked = async (...argv: string[]) => {
    const r = await cli('ask', ...argv, '--engine', 'none', '--json');
    expect(r.code).toBe(0);
    return JSON.parse(r.out) as { kind: string; hits: { entryId: number; quote: string }[] };
  };

  it('keeps every kind of question to the sessions run in that folder', async () => {
    expect((await asked('when did I first mention reminders')).hits[0]!.quote).toMatch(/invoices/);
    const first = await asked('when did I first mention reminders', '--project', 'plotline');
    expect(first.kind).toBe('first');
    expect(first.hits.map((h) => h.quote)).toEqual(['Reminders go out twice in plotline.', 'Decided: reminders go out once, at nine.']);

    expect((await asked('what did I decide about reminders', '--project', '/home/mara/code/ledger')).hits.map((h) => h.quote)).toEqual([
      'Decided: reminders for invoices go out weekly.',
    ]);
    expect((await asked('reminders', '--project', 'web')).hits.map((h) => h.quote)).toEqual(['Decided: reminders go out once, at nine.']);
  });

  it('matches whole folder names, as search does', async () => {
    const r = await cli('ask', 'reminders', '--project', 'plot', '--engine', 'none');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Nothing in your record matches "reminders".');
  });
});
