// The page's start: the token from the address, the clip and seed-view switches, then the app.

import { render } from 'preact';
import { boot, openCommand, openEditor, openEntry, openNav, openPanel, light, message, toast } from './actions.ts';
import { api, initToken, qs } from './api.ts';
import { App } from './App.tsx';
import { growOnNextLoad } from './brain/useBrain.ts';
import { linkDegree } from './groups.ts';
import { getState, setState, type View } from './store.ts';
import type { Hit } from './types.ts';
import './styles.css';

const params = new URLSearchParams(location.search);
const clip = params.get('clip') === '1';
const seed = params.get('seedview');
const entry = Number(params.get('entry'));
const query = params.get('q');

if (clip) document.documentElement.classList.add('clip');
if (seed === 'grow') growOnNextLoad();

const narrow = window.matchMedia('(max-width: 699px)');
setState({ clip, compact: narrow.matches });
narrow.addEventListener('change', () => setState({ compact: narrow.matches }));

initToken();
render(<App />, document.getElementById('app')!);

void boot().then(applySeed);

/** The note with the most links, for seed views that need an entry to show. */
function showcaseNote(): { id: number; title: string } | null {
  const brain = getState().brain;
  if (!brain?.points.length) return null;
  const degree = linkDegree(brain);
  let best = -1;
  brain.points.forEach((p, i) => {
    if (p[1] === 1 && (best < 0 || degree[i]! > degree[best]!)) best = i;
  });
  const p = brain.points[best < 0 ? 0 : best]!;
  return { id: p[0], title: p[8] };
}

async function applySeed(): Promise<void> {
  const s = getState();
  if (!s.ready || s.locked || s.fatal) return;
  if (seed && seed !== 'firstrun') setState({ firstRun: false });
  const views: Record<string, View> = { brain: 'brain', navigator: 'navigator', numbers: 'numbers', timeline: 'timeline', you: 'you', lab: 'lab' };
  if (seed && views[seed]) setState({ view: views[seed] });
  switch (seed) {
    case 'rings':
    case 'clusters':
      setState({ view: 'brain', layout: seed });
      break;
    case 'tides':
      setState({ view: 'lab', labTab: 'tides' });
      break;
    case 'learn':
      openPanel({ kind: 'learn' });
      break;
    case 'add':
      openPanel({ kind: 'add' });
      break;
    case 'reader': {
      const note = showcaseNote();
      if (note) openEntry(note.id);
      break;
    }
    case 'editor': {
      const note = showcaseNote();
      if (note) openEditor(note.id, note.title);
      break;
    }
    case 'settings':
      setState({ settingsOpen: true });
      break;
    case 'firstrun':
      setState({ firstRun: true });
      break;
    case 'menu':
      setState({ menuOpen: true });
      break;
    case 'command':
      openCommand(query ?? '');
      break;
    case 'hub': {
      const hubs = getState().brain?.hubs ?? [];
      const biggest = hubs.reduce<(typeof hubs)[number] | null>((a, h) => (!a || h.entries.length > a.entries.length ? h : a), null);
      if (biggest) openPanel({ kind: 'hub', id: biggest.id });
      break;
    }
    case 'review':
    case 'runs':
    case 'hubs':
    case 'folders':
    case 'inbox':
      openNav({ kind: seed });
      break;
  }
  if (Number.isInteger(entry) && entry > 0) openEntry(entry);
  if (query && seed !== 'command') {
    try {
      const res = await api.get<{ hits: Hit[] }>(`search${qs({ q: query, limit: 500 })}`);
      light(
        res.hits.map((h) => h.id),
        `“${query}”`,
      );
    } catch (error) {
      toast(`Search failed: ${message(error)}`, { tone: 'error' });
    }
  }
}
