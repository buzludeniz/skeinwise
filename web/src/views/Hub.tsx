// A concept hub: the organiser's reading of a set of entries, every line citing your own dated words.

import { PencilLine, Merge, RefreshCw, ThumbsDown } from 'lucide-preact';
import { closePanel, openEntry } from '../actions.ts';
import { fmtDate } from '../format.ts';
import { useApp } from '../store.ts';
import type { HubItem } from '../types.ts';
import { Button, Empty, SidePanel } from '../ui/common.tsx';
import { organiserPending } from './Organiser.tsx';

const SECTIONS: ['in_short' | 'what_you_found' | 'open_ends', string][] = [
  ['in_short', 'In short'],
  ['what_you_found', 'What you found'],
  ['open_ends', 'Open ends'],
];

function Item({ item }: { item: HubItem }) {
  return (
    <li>
      <p>{item.text}</p>
      <button type="button" class="quote" onClick={() => openEntry(item.entryId)}>
        Your words, {fmtDate(item.date)}
      </button>
    </li>
  );
}

export function HubPanel({ id }: { id: number }) {
  const hub = useApp((s) => s.organiser.hubs.find((h) => h.id === id) ?? null);
  const runs = useApp((s) => s.organiser.runs);
  if (!hub)
    return (
      <SidePanel title="Concept hub" label="Concept hub" onClose={closePanel}>
        <Empty title="This hub is gone">
          <p>It may have been merged or undone.</p>
        </Empty>
      </SidePanel>
    );
  const run = runs.find((r) => r.id === hub.runId);
  return (
    <SidePanel title={hub.name} label="Concept hub" onClose={closePanel}>
      <p class="eyebrow">Concept hub</p>
      <p class="band band-machine">
        The organiser's reading of {hub.entries.length} of your entries, not your words. Written by{' '}
        {run ? `${run.engine === 'none' ? 'no AI' : run.engine}${run.model ? ` (${run.model})` : ''}` : 'the organiser'} in run {hub.runId}.
      </p>
      {SECTIONS.map(([key, label]) => (
        <section key={key} class="reader-section">
          <h3>{label}</h3>
          {hub.sections[key].length ? (
            <ul class="hub-items">
              {hub.sections[key].map((item, i) => (
                <Item key={i} item={item} />
              ))}
            </ul>
          ) : (
            <p class="soft">Nothing here yet.</p>
          )}
        </section>
      ))}
      <div class="row wrap">
        <Button icon={PencilLine} small onClick={organiserPending}>
          Rename
        </Button>
        <Button icon={Merge} small onClick={organiserPending}>
          Merge into…
        </Button>
        <Button icon={ThumbsDown} small kind="quiet" onClick={organiserPending}>
          Not useful
        </Button>
        <Button icon={RefreshCw} small kind="quiet" onClick={organiserPending}>
          Refresh
        </Button>
      </div>
    </SidePanel>
  );
}
