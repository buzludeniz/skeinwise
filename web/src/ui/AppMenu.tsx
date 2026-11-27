// The app menu under the mark: the items and order from docs/ui.md.

import { useEffect, useRef, useState } from 'preact/hooks';
import { ChevronRight } from 'lucide-preact';
import { lock, message, openCommand, openPanel, quit, refreshStatus, saveConfig, toast } from '../actions.ts';
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

  // The two lines under Live capture change as things happen, so they're read again while the menu is open.
  useEffect(() => {
    if (!open) return;
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 2000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (sub === 'connect' && !agents) api.get<Agent[]>('agents').then(setAgents, () => setAgents([]));
  }, [sub]);

  if (!open) return null;
  const close = () => setState({ menuOpen: false });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  // Once the stream has run, its own two lines (src/live/capture.ts statusLines); before that, what the record holds.
  const live = status?.live;
  const lines = live?.lines ?? [
    status?.lastSaved ? `saved ${ago(status.lastSaved)}` : 'nothing saved yet',
    `${status?.entries ?? 0} entries in the record`,
  ];

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
      <div class="menu-sep" role="separator" />
      <div class="menu-live" role="group" aria-label="Live capture">
        <Switch
          role="menuitemcheckbox"
          checked={recordLive}
          label="Live capture"
          onChange={(v) => {
            void saveConfig({ recordLive: v }).then((ok) => {
              if (ok) void refreshStatus();
            });
          }}
        />
        <p class="menu-status">{lines[0]}</p>
        <p class="menu-status">{lines[1]}</p>
        {live?.error && (
          <p class="menu-status menu-error" role="alert">
            {live.error}
          </p>
        )}
      </div>
      <div class="menu-sep" role="separator" />
      <div class="menu-sub-wrap">
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={sub === 'connect'} onClick={() => setSub(sub === 'connect' ? null : 'connect')}>
          Connect <ChevronRight size={14} aria-hidden="true" />
        </button>
        {sub === 'connect' && (
          <div class="submenu" role="menu" aria-label="Connect">
            {/* A menu must hold a menu item. Until the list comes, or when it can't, its stand-in line is one, disabled:
                a menu holding only a paragraph is what axe flags (aria-required-children). */}
            {!agents?.length && (
              <p class="menu-status" role="menuitem" aria-disabled="true" tabIndex={-1}>
                {agents ? "Couldn't look for agents." : 'Looking…'}
              </p>
            )}
            {agents?.map((a) => (
              <div class="submenu-row" key={a.key}>
                <span>{a.label}</span>
                <button
                  type="button"
                  role="menuitem"
                  class="btn btn-small btn-quiet"
                  disabled={!a.found}
                  onClick={run(() => toast(`To give ${a.label} your record as its memory, run skeinwise connect ${a.key} in a terminal.`))}
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
      <div class="menu-sep" role="separator" />
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
