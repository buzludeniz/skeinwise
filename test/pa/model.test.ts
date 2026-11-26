import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.ts';
import { createModel } from '../../src/organiser/model.ts';
import { RecordView } from '../../src/organiser/record.ts';
import { listRuns } from '../../src/organiser/runs.ts';
import { findLoopsWith, LOOP_CHUNK, makeBriefWith, readLoops, unreadSentences } from '../../src/pa/model.ts';
import { NOW, paStore } from './fixture.ts';

// A fake model behind an injected fetch: nothing leaves the process, and the URL is a port no one uses.
const CONFIG = { ...DEFAULT_CONFIG, localUrl: 'http://127.0.0.1:8799/v1' };

function fakeModel(reply: (user: string) => unknown, sent: string[] = []) {
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'fake-4b' }] });
    const body = JSON.parse(String(init!.body)) as { messages: { role: string; content: string }[] };
    const user = body.messages[1]!.content;
    sent.push(user);
    const content = JSON.stringify(reply(user));
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 40 } });
  }) as typeof globalThis.fetch;
  return { engine: 'local' as const, client: createModel(CONFIG, 'local', { fetch, env: {} }), budget: 0 };
}

/** The S labels the request gave to sentences matching a pattern. */
function labels(user: string, pattern: RegExp): string[] {
  return [...user.matchAll(/^(S\d+) \([\d-]+\): (.*)$/gm)].filter((m) => pattern.test(m[2]!)).map((m) => m[1]!);
}

describe('a model brief', () => {
  it('adds written lines that cite entries, as an ask run', async () => {
    const store = paStore();
    const record = new RecordView(store);
    const sent: string[] = [];
    const engine = fakeModel(() => ({ lines: [{ text: 'You sent Ana the river report and booked the kiln.', cites: ['E1'] }] }), sent);
    const { brief, message } = await makeBriefWith(record, { now: NOW }, engine);
    const daily = record.entries.find((e) => e.title === '2026-11-25')!;
    expect(message).toBeNull();
    expect(sent[0]).toMatch(/E1 \(2026-11-25, me, "2026-11-25"\): .*Sent Ana the river report\./);
    expect(brief).toMatchObject({ engine: 'local', model: 'fake-4b' });
    expect(brief.body.lines).toEqual([{ text: 'You sent Ana the river report and booked the kiln.', cites: [daily.id] }]);
    expect(brief.body.counts.entries).toBe(1);
    const run = listRuns(store.db).find((r) => r.id === brief.runId)!;
    expect(run).toMatchObject({ task: 'ask', status: 'done', engine: 'local', tokensIn: 200, tokensOut: 40 });
  });

  it("keeps the No-AI brief and says why when the model's answer doesn't fit", async () => {
    const store = paStore();
    const engine = fakeModel(() => ({ lines: [{ text: 'Made up.', cites: ['E7'] }] }));
    const { brief, message } = await makeBriefWith(new RecordView(store), { now: NOW }, engine);
    expect(brief).toMatchObject({ engine: 'none', runId: null });
    expect(brief.body.lines).toEqual([]);
    expect(message).toMatch(/didn't write the brief, so this is the No-AI one\. .*E7/);
    expect(listRuns(store.db)[0]).toMatchObject({ task: 'ask', status: 'failed' });
  });

  it('asks nothing when nothing is new', async () => {
    const store = paStore();
    const record = new RecordView(store);
    await makeBriefWith(record, { now: NOW }, { engine: 'none', budget: 0 });
    const sent: string[] = [];
    const { brief, message } = await makeBriefWith(record, { now: NOW }, fakeModel(() => ({ lines: [] }), sent));
    expect(sent).toEqual([]);
    expect(brief.engine).toBe('none');
    expect(message).toMatch(/Nothing new/);
  });
});

describe('a model reading loops', () => {
  it('reads your unread sentences, and its reading wins over the cues', async () => {
    const store = paStore();
    const record = new RecordView(store);
    const unread = unreadSentences(record, NOW).map((s) => s.sentence);
    expect(unread).toContain("Haven't heard back from the landlord.");
    expect(unread).not.toContain('I need to fix the failing test.');
    expect(unread).not.toContain("I'll send you a summary.");
    expect(unread).not.toContain('Fed the starter at 18:00.');

    const sent: string[] = [];
    const engine = fakeModel(
      (user) => ({
        loops: [
          ...labels(user, /rye flour/).map((s) => ({ s, kind: 'todo', what: 'Order rye flour', who: 'null', due: '2026-11-28' })),
          ...labels(user, /call the vet/).map((s) => ({ s, kind: 'reminder', what: 'Call the vet', who: null, due: '2026-11-30' })),
        ],
      }),
      sent,
    );
    const { loops, read, message } = await findLoopsWith(record, { now: NOW }, engine);
    expect(message).toBeNull();
    expect(read).toMatchObject({ read: unread.length, loops: 2, left: 0 });
    expect(loops.map((l) => [l.what, l.by, l.dueDay, l.followUp])).toEqual([
      ['Call the vet', 'local', '2026-11-30', false],
      ['Order rye flour', 'local', '2026-11-28', false],
    ]);
    expect(listRuns(store.db)[0]).toMatchObject({ task: 'ask', status: 'done', counts: { read: unread.length, loops: 2 } });

    // Everything is read now, so a second pass asks nothing.
    expect(unreadSentences(record, NOW)).toEqual([]);
    const again = await findLoopsWith(record, { now: NOW }, engine);
    expect(sent).toHaveLength(1);
    expect(again.read).toEqual({ read: 0, loops: 0, left: 0, runId: null });
  });

  it('sends the sentences in chunks', async () => {
    const store = paStore();
    store.ingest({
      source: { kind: 'notes', label: 'More notes', location: '/invented/more' },
      threads: [],
      entries: [{ externalId: 'long.md', kind: 'note', speaker: 'you', title: 'Long', createdAt: '2026-11-22T12:00:00.000Z', body: Array.from({ length: LOOP_CHUNK + 5 }, (_, i) => `I will water bed ${i + 1}.`).join(' ') }],
    });
    const sent: string[] = [];
    const read = await readLoops(new RecordView(store), NOW, fakeModel(() => ({ loops: [] }), sent));
    expect(sent).toHaveLength(2);
    expect(read.loops).toBe(0);
  });

  it('keeps the cue reading and says why when the model fails', async () => {
    const store = paStore();
    const record = new RecordView(store);
    const { loops, message } = await findLoopsWith(record, { now: NOW }, fakeModel(() => ({ loops: [{ s: 'S1', kind: 'chore', what: 'x' }] })));
    expect(message).toMatch(/from the cue lists alone\. .*kind "chore"/);
    expect(loops.every((l) => l.by === 'none')).toBe(true);
    expect(loops).toHaveLength(3);
    expect(listRuns(store.db)[0]).toMatchObject({ status: 'failed' });
  });

  it('refuses a due day that is not a day', async () => {
    const store = paStore();
    const engine = fakeModel((user) => ({ loops: labels(user, /rye flour/).map((s) => ({ s, kind: 'todo', what: 'Rye', due: 'Friday' })) }));
    const { message } = await findLoopsWith(new RecordView(store), { now: NOW }, engine);
    expect(message).toMatch(/due "Friday", which is not a day/);
  });
});
