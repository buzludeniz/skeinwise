import { describe, expect, it } from 'vitest';
import { RecordView } from '../../src/organiser/record.ts';
import { briefText, latestBrief, listBriefs, makeBrief, newSinceBrief } from '../../src/pa/brief.ts';
import { addTask } from '../../src/pa/tasks.ts';
import { NOW, paStore } from './fixture.ts';

const NEXT = '2026-11-26T08:00:00.000Z';

function setup() {
  let clock = NOW;
  const store = paStore(() => clock);
  return { store, record: () => new RecordView(store), at: (t: string) => (clock = t) };
}

describe('the daily brief', () => {
  it('covers the last day the first time', () => {
    const { store, record } = setup();
    addTask(store.db, { title: 'Order rye flour', dueDay: '2026-11-24' }, NOW);
    const brief = makeBrief(record(), { now: NOW });
    expect(brief).toMatchObject({ day: '2026-11-25', fromMark: 0, engine: 'none', model: null, runId: null });
    expect(brief.body.since).toBe('2026-11-24T17:00:00.000Z');
    expect(brief.body.counts).toEqual({ entries: 1, yours: 1, threads: 0, notes: 1, edited: 0, older: 0 });
    expect(brief.body.threads).toEqual([{ entryId: expect.any(Number), title: '2026-11-25', source: 'Notes', entries: 1 }]);
    expect(brief.body.followUps).toBe(1);
    expect(brief.body.tasks).toMatchObject({ open: 1, overdue: 1 });
    expect(brief.body.lines).toEqual([]);
    expect(newSinceBrief(store.db)).toBe(0);
  });

  it('then covers only what came since, quoting only the sentences an edit added', () => {
    const { store, record, at } = setup();
    const first = makeBrief(record(), { now: NOW });
    at(NEXT);
    const market = record().entries.find((e) => e.title === 'Market')!;
    store.editEntry(market.id, `${market.body}\nDecided: we're going with the blue stall. Should I raise the price? I'll email Ben the invoice tomorrow.`);
    store.ingest({
      source: { kind: 'chatgpt', label: 'ChatGPT' },
      threads: [
        { externalId: 'old', title: 'Old recipes', entries: [{ externalId: 'old:0', kind: 'message', speaker: 'you', createdAt: '2025-03-01T10:00:00.000Z', body: 'I need to try rye.' }] },
        {
          externalId: 'new',
          title: 'Kiln times',
          entries: [
            { externalId: 'new:0', kind: 'message', speaker: 'you', createdAt: '2026-11-26T07:00:00.000Z', body: 'How long does a bisque firing take?' },
            { externalId: 'new:1', kind: 'message', speaker: 'assistant', createdAt: '2026-11-26T07:00:04.000Z', body: 'About eight hours.' },
          ],
        },
      ],
    });
    expect(newSinceBrief(store.db)).toBe(4);

    const brief = makeBrief(record(), { now: NEXT });
    expect(brief.fromMark).toBe(first.toMark);
    expect(brief.body.since).toBe(first.createdAt);
    expect(brief.body.counts).toEqual({ entries: 3, yours: 2, threads: 1, notes: 1, edited: 1, older: 1 });
    expect(brief.body.older).toEqual([{ source: 'ChatGPT', entries: 1 }]);
    expect(brief.body.threads.map((t) => [t.title, t.entries])).toEqual([
      ['Kiln times', 2],
      ['Market', 1],
    ]);
    expect(brief.body.decided).toEqual([{ entryId: market.id, quote: "Decided: we're going with the blue stall.", where: 'Market' }]);
    expect(brief.body.questions).toEqual([{ entryId: market.id, quote: 'Should I raise the price?', where: 'Market' }]);
    expect(brief.body.loops.map((l) => [l.kind, l.what])).toEqual([['promise', 'Email Ben the invoice tomorrow']]);

    const text = briefText(brief);
    expect(text).toContain('3 new or changed entries (2 yours, 1 note, 1 thread, 1 edited).');
    expect(text).toContain('Also brought in: 1 older from ChatGPT.');
    expect(text).toContain(`"Decided: we're going with the blue stall." [${market.id}]`);
    expect(text).toContain('Email Ben the invoice tomorrow (promise)');
    expect(latestBrief(store.db)?.id).toBe(brief.id);
    expect(listBriefs(store.db).map((b) => b.id)).toEqual([brief.id, first.id]);
  });

  it('says plainly when nothing is new', () => {
    const { record } = setup();
    makeBrief(record(), { now: NOW });
    const empty = makeBrief(record(), { now: NEXT });
    expect(empty.body.counts.entries).toBe(0);
    expect(briefText(empty)).toContain('Nothing new since the last brief.');
  });

  it('covers from a moment you give, leaving out entries dated in the future', () => {
    const { record } = setup();
    const brief = makeBrief(record(), { now: NOW, since: '2026-11-20' });
    expect(brief.body.counts).toMatchObject({ entries: 6, yours: 5, threads: 2, notes: 3 });
    expect(brief.body.threads.map((t) => t.title)).not.toContain('Planted');
    expect(() => makeBrief(record(), { now: NOW, since: 'last week' })).toThrow(/not a moment/);
    expect(() => makeBrief(record(), { now: NOW, since: '2026-12-01' })).toThrow(/before now/);
  });
});
