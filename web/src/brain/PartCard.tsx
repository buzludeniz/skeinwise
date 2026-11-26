// The card one click pins: what the selected point is, a way to open it, a way to light what is around it, and the
// entries it leads to. An entry's card asks the server for its links (GET /api/links/:id); a hub's card lists its
// entries from the record already loaded.

import { useEffect, useRef, useState } from 'preact/hooks';
import { BookOpen, Sparkles, X } from 'lucide-preact';
import { light, message, openEntry, openPanel } from '../actions.ts';
import { api } from '../api.ts';
import { fmtDate, plural, speakerName } from '../format.ts';
import type { BrainData } from '../../../src/server/queries.ts';
import type { EntryLines } from '../types.ts';
import { Button } from '../ui/common.tsx';
import { type EntryPart, type HubPart, hubEntryIds, hubMembers, linkedRows, neighbourIds, type Part, type Row } from './parts.ts';

/** How many of a hub's entries the card lists; the hub's panel has them all. */
export const HUB_ROWS = 30;

interface CardProps {
  part: Part;
  record: BrainData;
  /** A row was chosen: select that point if the brain draws it, or open it. */
  onPick: (point: number) => void;
  onClose: () => void;
  /** Move keyboard focus to the card's title when it opens (it was selected with the keyboard). */
  takeFocus: boolean;
}

export function PartCard({ part, record, onPick, onClose, takeFocus }: CardProps) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (takeFocus) title.current?.focus({ preventScroll: true });
  }, [part.point, takeFocus]);
  const name = part.kind === 'entry' ? part.title : part.name;
  return (
    <aside class="part-card" aria-labelledby="part-card-title" data-point={part.point}>
      <header>
        <h2 id="part-card-title" tabIndex={-1} ref={title}>
          {name}
        </h2>
        <Button icon={X} kind="quiet" small aria-label="Close the card" title="Close (Esc)" onClick={onClose} />
      </header>
      {part.kind === 'entry' ? <EntryBody part={part} record={record} onPick={onPick} /> : <HubBody part={part} record={record} onPick={onPick} />}
    </aside>
  );
}

type Links = { state: 'loading' } | { state: 'ready'; lines: EntryLines } | { state: 'failed'; error: string };

function EntryBody({ part, record, onPick }: { part: EntryPart; record: BrainData; onPick: (point: number) => void }) {
  const [links, setLinks] = useState<Links>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    setLinks({ state: 'loading' });
    api.get<EntryLines>(`links/${part.id}`).then(
      (lines) => live && setLinks({ state: 'ready', lines }),
      (error: unknown) => live && setLinks({ state: 'failed', error: message(error) }),
    );
    return () => {
      live = false;
    };
  }, [part.id]);
  const rows = links.state === 'ready' ? linkedRows(links.lines, record) : [];
  return (
    <>
      <p class="part-meta">
        {fmtDate(part.at)} · {part.source}
      </p>
      <p class="part-meta">
        {part.type}
        {part.speaker ? ` · ${speakerName(part.speaker)}` : ''}
        {part.thread ? ` · in “${part.thread}”` : ''}
      </p>
      <div class="part-actions">
        <Button icon={BookOpen} kind="primary" small onClick={() => openEntry(part.id)}>
          Open
        </Button>
        <Button
          icon={Sparkles}
          kind="quiet"
          small
          disabled={links.state !== 'ready'}
          title={links.state === 'ready' ? 'Light this entry and the ones around it' : 'Waits for the links'}
          onClick={() => links.state === 'ready' && light(neighbourIds(links.lines), `Around “${part.title}”`)}
        >
          Light neighbours
        </Button>
      </div>
      <h3 class="part-subhead">Linked entries</h3>
      {links.state === 'loading' && (
        <p class="part-note" role="status">
          Loading its links…
        </p>
      )}
      {links.state === 'failed' && (
        <p class="part-note part-error" role="alert">
          Couldn't load its links: {links.error}
        </p>
      )}
      {links.state === 'ready' && (rows.length ? <Rows rows={rows} onPick={onPick} label="Linked entries" /> : <p class="part-note">No links yet.</p>)}
    </>
  );
}

function HubBody({ part, record, onPick }: { part: HubPart; record: BrainData; onPick: (point: number) => void }) {
  const members = hubMembers(record, part.id);
  const shown = members.slice(0, HUB_ROWS);
  // Counted against the whole record: in a sample, the page has only some of a hub's entries, and Open lists them all.
  const more = Math.max(part.count, members.length) - shown.length;
  return (
    <>
      <p class="part-meta">Concept hub · {plural(part.count, 'entry', 'entries')}</p>
      <div class="part-actions">
        <Button icon={BookOpen} kind="primary" small onClick={() => openPanel({ kind: 'hub', id: part.id })}>
          Open
        </Button>
        <Button
          icon={Sparkles}
          kind="quiet"
          small
          disabled={members.length === 0}
          title="Light the entries in this hub"
          onClick={() => light(hubEntryIds(record, part.id), part.name)}
        >
          Light its entries
        </Button>
      </div>
      <h3 class="part-subhead">Its entries</h3>
      {shown.length ? <Rows rows={shown} onPick={onPick} label="Its entries" /> : <p class="part-note">No entries in the record yet.</p>}
      {more > 0 && <p class="part-note">and {plural(more, 'more entry', 'more entries')}: Open shows them all.</p>}
    </>
  );
}

function Rows({ rows, onPick, label }: { rows: Row[]; onPick: (point: number) => void; label: string }) {
  return (
    <ul class="part-rows" aria-label={label}>
      {rows.map((r) => (
        <li key={r.point}>
          <button type="button" onClick={() => onPick(r.point)}>
            <span class="part-row-title">{r.title}</span>
            <span class="part-row-why">
              {r.why}
              {r.at !== undefined ? ` · ${fmtDate(r.at)}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
