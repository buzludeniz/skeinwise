// Numbers: plain figures about the record. Entries, threads, notes, hubs and sources; your words and the
// assistants'; the busiest months; and how far the organiser has got.

import { useEffect, useState } from 'preact/hooks';
import { message } from '../actions.ts';
import { api } from '../api.ts';
import { fmtMonth, fmtNum, fmtRange, fmtShare, speakerName } from '../format.ts';
import { useApp } from '../store.ts';
import type { Numbers } from '../types.ts';
import { Empty } from '../ui/common.tsx';

function Figure({ value, label, note }: { value: string; label: string; note?: string }) {
  return (
    <div class="figure">
      <span class="figure-value">{value}</span>
      <span class="figure-label">{label}</span>
      {note && <span class="figure-note">{note}</span>}
    </div>
  );
}

/** A labelled bar list: one row per item, the bar's length its share of the largest. */
function Bars({ title, rows }: { title: string; rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <section class="card bars-card" aria-label={title}>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p class="soft">Nothing yet.</p>
      ) : (
        <ul class="bar-list">
          {rows.map((r) => (
            <li key={r.label}>
              <span class="bar-label" title={r.label}>
                {r.label}
              </span>
              <span class="bar-track" aria-hidden="true">
                <span class="bar-fill" style={{ width: `${(r.value / max) * 100}%` }} />
              </span>
              <span class="bar-value">{fmtNum(r.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function NumbersView() {
  const revision = useApp((s) => s.revision);
  const [n, setN] = useState<Numbers | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get<Numbers>('stats').then(
      (d) => live && (setN(d), setError(null)),
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [revision]);

  if (error)
    return (
      <section class="view numbers" aria-label="Numbers">
        <Empty title="Couldn't count the record">{error}</Empty>
      </section>
    );
  if (!n)
    return (
      <section class="view numbers" aria-label="Numbers" aria-busy="true">
        <p class="soft pad">Counting…</p>
      </section>
    );

  const spoken = n.yours + n.assistants;
  const busiest = [...n.byMonth].sort((a, b) => b.entries - a.entries || a.month.localeCompare(b.month)).slice(0, 6);

  return (
    <section class="view numbers" aria-label="Numbers">
      <header class="view-head">
        <h1>Numbers</h1>
        {n.first && <p class="soft">{fmtRange(n.first, n.last)}</p>}
      </header>
      <div class="numbers-body">
        <div class="figures">
          <Figure value={fmtNum(n.entries)} label="Entries" />
          <Figure value={fmtNum(n.threads)} label="Threads" />
          <Figure value={fmtNum(n.notes)} label="Notes" />
          <Figure value={n.hubs === null ? '–' : fmtNum(n.hubs)} label="Hubs" note={n.hubs === null ? 'Once the organiser runs' : undefined} />
          <Figure value={fmtNum(n.sources)} label="Sources" />
        </div>

        <section class="card" aria-label="Your words and the assistants'">
          <h2>Your words and the assistants’</h2>
          {spoken === 0 ? (
            <p class="soft">No conversations yet.</p>
          ) : (
            <>
              <div class="split-bar" role="img" aria-label={`You ${fmtShare(n.yours / spoken)}, assistants ${fmtShare(n.assistants / spoken)}`}>
                <span class="split-you" style={{ width: `${(n.yours / spoken) * 100}%` }} />
                <span class="split-them" style={{ width: `${(n.assistants / spoken) * 100}%` }} />
              </div>
              <div class="split-legend">
                <span>
                  <span class="dot split-you" aria-hidden="true" /> You: {fmtNum(n.yours)} ({fmtShare(n.yours / spoken)})
                </span>
                <span>
                  <span class="dot split-them" aria-hidden="true" /> Assistants: {fmtNum(n.assistants)} ({fmtShare(n.assistants / spoken)})
                </span>
              </div>
            </>
          )}
        </section>

        <div class="numbers-grid">
          <Bars title="Busiest months" rows={busiest.map((m) => ({ label: fmtMonth(m.month), value: m.entries }))} />
          <Bars title="By source" rows={n.bySource.slice(0, 10).map((s) => ({ label: s.label, value: s.entries }))} />
          <Bars title="By speaker" rows={n.bySpeaker.slice(0, 10).map((s) => ({ label: speakerName(s.speaker), value: s.entries }))} />
        </div>

        <section class="card" aria-label="Organiser progress">
          <h2>How far the organiser has got</h2>
          {n.organiser ? (
            <ul class="bar-list">
              {(
                [
                  ['Tagged', n.organiser.tagged],
                  ['Filed', n.organiser.filed],
                  ['Summarised', n.organiser.summarised],
                ] as const
              ).map(([label, share]) => (
                <li key={label}>
                  <span class="bar-label">{label}</span>
                  <span class="bar-track" aria-hidden="true">
                    <span class="bar-fill" style={{ width: `${share * 100}%` }} />
                  </span>
                  <span class="bar-value">{fmtShare(share)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p class="soft">The organiser hasn’t run on this record yet. Once it does, this shows the share of entries it has tagged, filed and summarised.</p>
          )}
        </section>
      </div>
    </section>
  );
}
