// The app menu under the mark: the items and order from docs/ui.md.

import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronRight } from 'lucide-preact';
import { lock, message, openCommand, openPanel, quit, saveConfig, toast } from '../actions.ts';
import { api } from '../api.ts';
import { ago } from '../format.ts';
import { setState, useApp } from '../store.ts';
import type { Agent } from '../types.ts';
import { ALT, MOD, Switch } from './common.tsx';

export const EXPORTS = [
  ['chatgpt', 'ChatGPT'],
  ['claude', 'Claude'],
  ['gemini', 'Gemini'],
] as const;

export function AppMenu({ onAddFiles }: { onAddFiles: () => void }) {
  const open = useApp((s) => s.menuOpen);
  const status = useApp((s) => s.status);
  const recordLive = useApp((s) => s.config?.recordLive ?? false);
  const [sub, setSub] = useState<'connect' | 'export' | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setSub(null);
      return;
    }
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (sub) setSub(null);
        else close();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem], [role=menuitemcheckbox]') ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
        next?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.rail-mark')) close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open, sub]);

  useEffect(() => {
    if (sub === 'connect' && !agents) api.get<Agent[]>('agents').then(setAgents, () => setAgents([]));
  }, [sub]);

  if (!open) return null;
  const close = () => setState({ menuOpen: false });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const saved = status?.lastSaved ? `Saved ${ago(status.lastSaved)}` : 'Nothing saved yet';

  return (
    <div class="app-menu" role="menu" aria-label="Skeinwise" ref={ref}>
      <button type="button" role="menuitem" onClick={run(() => window.focus())}>
        Open Skeinwise
      </button>
      <button type="button" role="menuitem" onClick={run(() => openCommand())}>
        Command bar <span class="menu-keys">{ALT}{MOD}K</span>
      </button>
      <button type="button" role="menuitem" onClick={run(onAddFiles)}>
        Add files…
      </button>
      <div class="menu-sep" />
      <div class="menu-live">
        <Switch
          checked={recordLive}
          label="Record live"
          onChange={(v) => {
            void saveConfig({ recordLive: v });
            if (v) toast('Live recording comes in version 0.3. Your choice is saved, and it starts then.');
          }}
        />
        <p class="menu-status">{saved}</p>
        <p class="menu-status">{recordLive ? 'Waiting for version 0.3 to watch your chats' : `${status?.entries ?? 0} entries in the record`}</p>
      </div>
      <div class="menu-sep" />
      <div class="menu-sub-wrap">
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={sub === 'connect'} onClick={() => setSub(sub === 'connect' ? null : 'connect')}>
          Connect <ChevronRight size={14} aria-hidden="true" />
        </button>
        {sub === 'connect' && (
          <div class="submenu" role="menu" aria-label="Connect">
            {!agents && <p class="menu-status">Looking…</p>}
            {agents?.map((a) => (
              <div class="submenu-row" key={a.key}>
                <span>{a.label}</span>
                <button
                  type="button"
                  role="menuitem"
                  class="btn btn-small btn-quiet"
                  disabled={!a.found}
                  onClick={run(() => toast(`The memory and window servers come in version 0.5. Then ${a.label} can connect here.`))}
                >
                  {a.found ? 'Connect' : 'Not found'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div class="menu-sub-wrap">
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={sub === 'export'} onClick={() => setSub(sub === 'export' ? null : 'export')}>
          Get an export <ChevronRight size={14} aria-hidden="true" />
        </button>
        {sub === 'export' && (
          <div class="submenu" role="menu" aria-label="Get an export">
            {EXPORTS.map(([key, label]) => (
              <button type="button" role="menuitem" key={key} onClick={run(() => openPanel({ kind: 'add', guide: key }))}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div class="menu-sep" />
      <button type="button" role="menuitem" onClick={run(() => void lock().catch((e: unknown) => toast(message(e), { tone: 'error' })))}>
        Lock
      </button>
      <button type="button" role="menuitem" onClick={run(() => setState({ settingsOpen: true }))}>
        Settings <span class="menu-keys">{MOD},</span>
      </button>
      <button type="button" role="menuitem" onClick={run(() => void quit())}>
        Quit
      </button>
    </div>
  );
}
