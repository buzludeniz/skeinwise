// An invented record for the assistant's tests: a few daily notes, a chat and a coding session around Wednesday
// 25 November 2026. Every name and line is made up.

import { openDb } from '../../src/store/db.ts';
import { type EntryInput, Store } from '../../src/store/store.ts';

export const NOW = '2026-11-25T17:00:00.000Z';

const note = (externalId: string, day: string, title: string, body: string): EntryInput => ({
  externalId,
  kind: 'note',
  speaker: 'you',
  title,
  createdAt: `${day}T12:00:00.000Z`,
  body,
});

export const NOTES: EntryInput[] = [
  note('daily/2026-11-20.md', '2026-11-20', '2026-11-20', "# 2026-11-20\n\n- I'll send Ana the river report by Friday.\n- [ ] order more rye flour\n- Fed the starter at 18:00."),
  note('market.md', '2026-11-24', 'Market', "Haven't heard back from the landlord. Remind me to call the vet on Monday. I should have sent it last week."),
  note('daily/2026-11-25.md', '2026-11-25', '2026-11-25', '# 2026-11-25\n\n- Sent Ana the river report.\n- Booked the kiln slot.'),
  note('van.md', '2026-09-01', 'Van', 'I need to renew the van insurance.'),
  note('planted.md', '2027-06-01', 'Planted', "I'll pay Ben back."),
];

/** A store holding the invented record, its clock stopped at NOW unless given one. */
export function paStore(clock: () => string = () => NOW): Store {
  return fillRecord(new Store(openDb(':memory:'), clock));
}

/** Puts the invented record into a store. */
export function fillRecord(store: Store): Store {
  store.ingest({ source: { kind: 'notes', label: 'Notes', location: '/invented/notes' }, threads: [], entries: NOTES });
  store.ingest({
    source: { kind: 'claude', label: 'Claude' },
    threads: [
      {
        externalId: 'c1',
        title: 'Stall prices',
        entries: [
          { externalId: 'c1:0', kind: 'message', speaker: 'you', createdAt: '2026-11-23T09:00:00.000Z', body: "I need to book the kiln slot before the fair. I'll send you the price list." },
          { externalId: 'c1:1', kind: 'message', speaker: 'assistant', createdAt: '2026-11-23T09:00:05.000Z', body: "I'll send you a summary. Decided: keep the loaf at four pounds." },
        ],
      },
    ],
  });
  store.ingest({
    source: { kind: 'claude-code', label: 'Claude Code' },
    threads: [
      {
        externalId: 'k1',
        title: 'Fix tests',
        entries: [{ externalId: 'k1:0', kind: 'message', speaker: 'you', createdAt: '2026-11-24T09:00:00.000Z', body: 'I need to fix the failing test.' }],
      },
    ],
  });
  return store;
}
