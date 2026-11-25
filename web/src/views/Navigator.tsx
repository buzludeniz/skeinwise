// Navigator: folders and hubs, then threads and notes, then the reader.

import { useMemo, useState } from 'preact/hooks';
import { Database, FileText, FolderTree, Inbox, ListChecks, MessagesSquare, Network, Workflow } from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import { openEntry, openNav, openPanel, openThread } from '../actions.ts';
import { fmtDate, fmtNum, plural, speakerName } from '../format.ts';
import { folderCounts, INBOX, type NavFilter, navItems, type NavSort, sourceCounts } from '../nav.ts';
import { type NavSection, useApp } from '../store.ts';
import { Empty, Segmented, Select } from '../ui/common.tsx';
import { FoldersList, HubsList, ReviewList, RunsList } from './Organiser.tsx';
import { Reader } from './Reader.tsx';

const PAGE = 200;
const DAY = 86_400_000;

function same(a: NavSection, b: NavSection): boolean {
  return a.kind === b.kind && ('key' in a ? a.key : '') === ('key' in b ? b.key : '');
}

function NavRow({ section, icon: Icon, label, count }: { section: NavSection; icon: LucideIcon; label: string; count?: number | string }) {
  const nav = useApp((s) => s.nav);
  const on = same(nav, section);
  return (
    <li>
      <button type="button" class={`row-button${on ? ' on' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => openNav(section)}>
        <Icon size={16} aria-hidden="true" />
        <span>{label}</span>
        {count !== undefined && <span class="soft">{count}</span>}
      </button>
    </li>
  );
}

function Sections() {
  const brain = useApp((s) => s.brain);
  const review = useApp((s) => s.organiser.review.filter((r) => r.status === 'open').length);
  const runs = useApp((s) => s.organiser.runs.length);
  const hubs = useApp((s) => s.organiser.hubs);
  const filed = useApp((s) => s.organiser.folders.length > 0);
  const fc = useMemo(() => (brain ? folderCounts(brain) : []), [brain]);
  const sc = useMemo(() => (brain ? sourceCounts(brain) : new Map<number, number>()), [brain]);
  const inbox = !brain ? 0 : filed ? (fc[brain.folders.indexOf(INBOX)] ?? 0) : brain.points.length;
  return (
    <nav class="nav-col nav-sections" aria-label="Sections">
      <ul>
        <NavRow section={{ kind: 'inbox' }} icon={Inbox} label="Inbox" count={fmtNum(inbox)} />
        <NavRow section={{ kind: 'review' }} icon={ListChecks} label="Review" count={review || undefined} />
        <NavRow section={{ kind: 'runs' }} icon={Workflow} label="Runs" count={runs || undefined} />
      </ul>
      <h3>
        <button type="button" class="link" onClick={() => openNav({ kind: 'folders' })}>
          Folders
        </button>
      </h3>
      <ul>
        {(brain?.folders ?? []).map((name, i) =>
          filed && name === INBOX ? null : <NavRow key={name} section={{ kind: 'folder', key: name }} icon={FolderTree} label={name} count={fmtNum(fc[i] ?? 0)} />,
        )}
      </ul>
      <h3>
        <button type="button" class="link" onClick={() => openNav({ kind: 'hubs' })}>
          Hubs
        </button>
      </h3>
      {hubs.length ? (
        <ul>
          {hubs.slice(0, 12).map((h) => (
            <li key={h.id}>
              <button type="button" class="row-button" onClick={() => openPanel({ kind: 'hub', id: h.id })}>
                <Network size={16} aria-hidden="true" />
                <span>{h.name}</span>
                <span class="soft">{fmtNum(h.entries)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="soft small pad-x">Run the organiser to make hubs.</p>
      )}
      <h3>Sources</h3>
      <ul>
        {(brain?.sources ?? []).map((s) => (
          <NavRow key={s.id} section={{ kind: 'source', key: String(s.id) }} icon={Database} label={s.label} count={fmtNum(sc.get(s.id) ?? 0)} />
        ))}
      </ul>
    </nav>
  );
}

const SINCE: [string, string][] = [
  ['any', 'Any time'],
  ['month', 'Last month'],
  ['year', 'Last year'],
];

function Items() {
  const nav = useApp((s) => s.nav);
  const brain = useApp((s) => s.brain);
  const panel = useApp((s) => s.panel);
  const [sort, setSort] = useState<NavSort>('date');
  const [source, setSource] = useState('all');
  const [speaker, setSpeaker] = useState('all');
  const [since, setSince] = useState('any');
  const [shown, setShown] = useState(PAGE);

  const last = useMemo(() => brain?.points.reduce((m, p) => Math.max(m, p[7]), 0) ?? 0, [brain]);
  const filed = useApp((s) => s.organiser.folders.length > 0);
  const items = useMemo(() => {
    if (!brain) return [];
    const f: NavFilter = {};
    // Before the file task runs nothing is filed, so the Inbox holds everything; after, what it left out.
    if (nav.kind === 'inbox' && filed) f.folder = brain.folders.indexOf(INBOX);
    if (nav.kind === 'folder') f.folder = brain.folders.indexOf(nav.key);
    if (nav.kind === 'source') f.source = Number(nav.key);
    else if (source !== 'all') f.source = Number(source);
    if (speaker !== 'all') f.speaker = Number(speaker);
    if (since !== 'any') f.since = last - (since === 'month' ? 31 : 366) * DAY;
    return navItems(brain, f, sort);
  }, [brain, nav, sort, source, speaker, since, last, filed]);

  if (!brain) return null;
  const heading =
    nav.kind === 'folder'
      ? nav.key
      : nav.kind === 'source'
        ? brain.sources.find((s) => s.id === Number(nav.key))?.label
        : 'Inbox';

  return (
    <section class="nav-col nav-items" aria-label={heading ?? 'Items'}>
      <header class="nav-head">
        <h2>{heading}</h2>
        {nav.kind === 'inbox' && (
          <p class="soft small">
            {filed ? 'What the file task left out of every folder.' : 'Nothing is filed until the organiser’s file task runs, so the Inbox holds everything.'}
          </p>
        )}
        <div class="nav-filters">
          <Segmented
            label="Sort"
            options={[
              ['date', 'Date'],
              ['name', 'Name'],
            ]}
            value={sort}
            onChange={setSort}
          />
          {nav.kind !== 'source' && (
            <Select
              label="Source"
              hideLabel
              value={source}
              options={[['all', 'All sources'], ...brain.sources.map((s) => [String(s.id), s.label] as [string, string])]}
              onChange={setSource}
            />
          )}
          <Select
            label="Speaker"
            hideLabel
            value={speaker}
            options={[['all', 'Anyone'], ...brain.speakers.map((s, i) => [String(i), speakerName(s)] as [string, string])]}
            onChange={setSpeaker}
          />
          <Select label="Date" hideLabel value={since} options={SINCE} onChange={setSince} />
        </div>
        <p class="soft small">{plural(items.length, 'item')}</p>
      </header>
      {items.length === 0 ? (
        nav.kind === 'inbox' && filed && source === 'all' && speaker === 'all' && since === 'any' ? (
          <Empty icon={Inbox} title="Everything is filed">
            <p>The file task put every entry in a folder.</p>
          </Empty>
        ) : (
          <Empty title="Nothing matches">
            <p>Try another source, speaker or date.</p>
          </Empty>
        )
      ) : (
        <ul class="item-list">
          {items.slice(0, shown).map((it) => {
            const on = panel && ((it.kind === 'thread' && panel.kind === 'thread' && panel.id === it.id) || (it.kind !== 'thread' && panel.kind === 'entry' && panel.id === it.id));
            return (
              <li key={`${it.kind}${it.id}`}>
                <button
                  type="button"
                  class={`item${on ? ' on' : ''}`}
                  aria-current={on ? 'true' : undefined}
                  onClick={() => (it.kind === 'thread' ? openThread(it.id) : openEntry(it.id))}
                >
                  {it.kind === 'thread' ? <MessagesSquare size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}
                  <span class="item-title">{it.title || 'Untitled'}</span>
                  <span class="item-meta">
                    {fmtDate(it.last)} · {brain.sources.find((s) => s.id === it.source)?.label}
                    {it.kind === 'thread' && ` · ${plural(it.count, 'entry', 'entries')}`}
                  </span>
                </button>
              </li>
            );
          })}
          {items.length > shown && (
            <li>
              <button type="button" class="btn btn-quiet more" onClick={() => setShown(shown + PAGE)}>
                Show {Math.min(PAGE, items.length - shown)} more
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function Middle() {
  const nav = useApp((s) => s.nav);
  const title = { review: 'Review', runs: 'Runs', hubs: 'Hubs', folders: 'Folders' }[nav.kind as string];
  if (!title) return <Items />;
  return (
    <section class="nav-col nav-items" aria-label={title}>
      <header class="nav-head">
        <h2>{title}</h2>
      </header>
      {nav.kind === 'review' && <ReviewList />}
      {nav.kind === 'runs' && <RunsList />}
      {nav.kind === 'hubs' && <HubsList />}
      {nav.kind === 'folders' && <FoldersList />}
    </section>
  );
}

export function Navigator() {
  const panel = useApp((s) => s.panel);
  const compact = useApp((s) => s.compact);
  const target = panel && (panel.kind === 'entry' || panel.kind === 'thread') ? panel : null;
  return (
    <section class={`view navigator${target ? ' reading' : ''}`} aria-label="Navigator">
      {!compact && <Sections />}
      {compact && <CompactSections />}
      <Middle />
      <section class="nav-col nav-reader" aria-label="Reader">
        {target ? (
          <Reader target={target} />
        ) : (
          <Empty title="Pick a thread or a note">
            <p>It opens here, with its layers, neighbours and history.</p>
          </Empty>
        )}
      </section>
    </section>
  );
}

function CompactSections() {
  const nav = useApp((s) => s.nav);
  const options: [string, string][] = [
    ['inbox', 'Inbox'],
    ['review', 'Review'],
    ['folders', 'Folders'],
    ['runs', 'Runs'],
    ['hubs', 'Hubs'],
  ];
  return (
    <div class="nav-chips">
      <Segmented label="Section" options={options} value={nav.kind} onChange={(k) => openNav({ kind: k as 'inbox' })} />
    </div>
  );
}
