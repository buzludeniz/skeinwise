// Profile: what the record says about you. The topics you return to, your projects, the people you mention, each as a
// span from first to latest mention; and Check a claim, which finds the entries that bear on a sentence.

import { useEffect, useMemo, useState } from 'preact/hooks';
import { Brain, ChevronDown, ChevronRight, FolderKanban, SearchCheck, Tags, Users } from 'lucide-preact';
import type { LucideIcon } from 'lucide-preact';
import { go, light, message, openEntry, toast } from '../actions.ts';
import { api, qs } from '../api.ts';
import { fmtDate, fmtMonth, plural, speakerName } from '../format.ts';
import { useApp } from '../store.ts';
import type { Brief, ProfileLine } from '../types.ts';
import { Button, Empty } from '../ui/common.tsx';

type About = { words: ProfileLine[]; names: ProfileLine[]; projects: ProfileLine[]; entries: number };
type Claim = { claim: string; entries: (Brief & { snippet: string })[] };

/** Where a date sits between the earliest and latest, 0..1. */
function at(date: string, from: number, to: number): number {
  const t = new Date(date).getTime();
  return to > from ? Math.min(1, Math.max(0, (t - from) / (to - from))) : 0.5;
}

function Line({ line, from, to, titles }: { line: ProfileLine; from: number; to: number; titles: Map<number, string> }) {
  const [open, setOpen] = useState(false);
  const a = at(line.first, from, to);
  const b = at(line.last, from, to);
  return (
    <li class={`profile-line${open ? ' open' : ''}`}>
      <button type="button" class="profile-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span class="profile-label">{line.label}</span>
        <span class="profile-track" aria-hidden="true">
          <span class="profile-span" style={{ left: `${a * 100}%`, width: `max(6px, ${(b - a) * 100}%)` }} />
        </span>
        <span class="profile-meta">
          {plural(line.count, 'entry', 'entries')} · {fmtDate(line.first) === fmtDate(line.last) ? fmtDate(line.first) : `${fmtMonth(line.first)} – ${fmtMonth(line.last)}`}
        </span>
      </button>
      {open && (
        <div class="profile-entries">
          <ul class="item-list">
            {line.ids.map((id) => (
              <li key={id}>
                <button type="button" class="item" onClick={() => openEntry(id)}>
                  <span class="item-title">{titles.get(id) || `Entry ${id}`}</span>
                </button>
              </li>
            ))}
          </ul>
          <div class="row">
            <Button
              icon={Brain}
              small
              onClick={() => {
                light(line.ids, line.label);
                go('brain');
              }}
            >
              Light them
            </Button>
            {line.count > line.ids.length && <span class="soft small">The first {line.ids.length} are listed.</span>}
          </div>
        </div>
      )}
    </li>
  );
}

function Group({ icon: Icon, title, lines, from, to, titles, empty }: { icon: LucideIcon; title: string; lines: ProfileLine[]; from: number; to: number; titles: Map<number, string>; empty: string }) {
  return (
    <section class="card profile-group" aria-label={title}>
      <h2>
        <Icon size={16} aria-hidden="true" /> {title}
      </h2>
      {lines.length ? (
        <ul class="profile-lines">
          {lines.map((l) => (
            <Line key={l.label} line={l} from={from} to={to} titles={titles} />
          ))}
        </ul>
      ) : (
        <p class="soft">{empty}</p>
      )}
    </section>
  );
}

function CheckClaim() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Claim | null>(null);
  const check = async () => {
    const q = text.trim();
    if (!q) return;
    setBusy(true);
    try {
      setResult(await api.get<Claim>(`claim${qs({ q })}`));
    } catch (error) {
      toast(`Couldn't check it: ${message(error)}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="card claim" aria-label="Check a claim">
      <h2>
        <SearchCheck size={16} aria-hidden="true" /> Check a claim
      </h2>
      <p class="soft small">Write a sentence about yourself, a line from a CV say. The record shows what bears on it.</p>
      <form
        class="row"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <input class="grow" value={text} placeholder="I led the move to a new database in 2025" aria-label="The claim" onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
        <Button kind="primary" type="submit" disabled={busy || !text.trim()}>
          {busy ? 'Checking…' : 'Check'}
        </Button>
      </form>
      {result &&
        (result.entries.length === 0 ? (
          <p class="soft">Nothing in the record touches this.</p>
        ) : (
          <>
            <p class="soft small">These entries share words with the claim. Read them to judge whether they back it up or argue with it.</p>
            <ul class="hits">
              {result.entries.map((e) => (
                <li key={e.id}>
                  <button type="button" class="hit" onClick={() => openEntry(e.id)}>
                    <span class="hit-title">{e.title || 'Untitled'}</span>
                    <span class="hit-meta">
                      {fmtDate(e.createdAt)} · {speakerName(e.speaker)} · {e.sourceLabel}
                    </span>
                    {e.snippet && <span class="hit-snippet">{e.snippet}</span>}
                  </button>
                </li>
              ))}
            </ul>
            <Button
              icon={Brain}
              small
              onClick={() => {
                light(
                  result.entries.map((e) => e.id),
                  'The claim',
                );
                go('brain');
              }}
            >
              See them in the brain
            </Button>
          </>
        ))}
    </section>
  );
}

export function ProfileView() {
  const revision = useApp((s) => s.revision);
  const brain = useApp((s) => s.brain);
  const [about, setAbout] = useState<About | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get<About>('you').then(
      (d) => live && (setAbout(d), setError(null)),
      (e: unknown) => live && setError(message(e)),
    );
    return () => {
      live = false;
    };
  }, [revision]);

  const titles = useMemo(() => new Map((brain?.points ?? []).map((p) => [p[0], p[8]] as [number, string])), [brain]);
  const span = useMemo(() => {
    const all = [...(about?.words ?? []), ...(about?.projects ?? []), ...(about?.names ?? [])];
    if (!all.length) return { from: 0, to: 0 };
    return {
      from: Math.min(...all.map((l) => new Date(l.first).getTime())),
      to: Math.max(...all.map((l) => new Date(l.last).getTime())),
    };
  }, [about]);

  return (
    <section class="view profile" aria-label="Profile">
      <header class="view-head">
        <h1>Profile</h1>
        {about && <p class="soft">From {plural(about.entries, 'entry', 'entries')} in your own words.</p>}
      </header>
      <div class="profile-body">
        {error ? (
          <Empty title="Couldn't read the record">{error}</Empty>
        ) : !about ? (
          <p class="soft pad">Reading…</p>
        ) : about.entries === 0 ? (
          <Empty icon={Users} title="Nothing in your words yet">
            <p>Bring in a conversation or write a note. What you return to shows up here.</p>
          </Empty>
        ) : (
          <>
            {span.to > span.from && (
              <div class="profile-axis" aria-hidden="true">
                <span>{fmtMonth(new Date(span.from))}</span>
                <span>{fmtMonth(new Date(span.to))}</span>
              </div>
            )}
            <Group icon={Tags} title="Topics you return to" lines={about.words} from={span.from} to={span.to} titles={titles} empty="No word comes up in more than one entry yet." />
            <Group
              icon={FolderKanban}
              title="Projects"
              lines={about.projects}
              from={span.from}
              to={span.to}
              titles={titles}
              empty="No projects yet. The organiser files entries into them when it runs."
            />
            <Group icon={Users} title="People you mention" lines={about.names} from={span.from} to={span.to} titles={titles} empty="No name comes up in more than one entry yet." />
          </>
        )}
        <CheckClaim />
      </div>
    </section>
  );
}
