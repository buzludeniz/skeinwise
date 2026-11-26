// Small shared pieces: buttons, switches, segmented choices, empty states, the logo.

import type { ButtonHTMLAttributes, ComponentChildren, RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';
import { X } from 'lucide-preact';
import markDark from '../../../docs/brand/logo-mark-dark.svg';
import markLight from '../../../docs/brand/logo-mark.svg';
import { useApp } from '../store.ts';
import { theme } from '../themes.ts';
import { panelId, tabId, tabStep } from './tabs.ts';

/**
 * The mark from docs/brand, used as it is: the light file on light themes and the dark one on dark themes, as the
 * folder's README asks. Without a title it is decoration, and the control around it carries the name.
 */
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  const light = useApp((s) => theme(s.config?.appearance.theme ?? 'dusk').light);
  return <img class="logo" src={light ? markLight : markDark} width={size} height={size} alt={title ?? ''} draggable={false} />;
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'icon'> & {
  icon?: LucideIcon;
  kind?: 'primary' | 'quiet' | 'danger' | 'plain';
  small?: boolean;
  children?: ComponentChildren;
};

export function Button({ icon: Icon, kind = 'plain', small, children, class: cls, type, ...rest }: ButtonProps) {
  return (
    <button type={(type as 'button' | 'submit' | undefined) ?? 'button'} class={`btn btn-${kind}${small ? ' btn-small' : ''}${children ? '' : ' btn-icon'} ${cls ?? ''}`} {...rest}>
      {Icon && <Icon size={small ? 14 : 16} aria-hidden="true" />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      class={`switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span class="switch-track" aria-hidden="true">
        <span class="switch-knob" />
      </span>
      <span class="switch-label">{label}</span>
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          class={value === key ? 'on' : ''}
          onClick={() => onChange(key)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/**
 * A row of tabs. Only the selected tab is in the Tab order; the arrow keys move to the next tab and select it, and Home
 * and End go to the first and the last. `id` ties the tabs to their panel, which takes `tabPanel(id, value)`.
 * `dotted` marks a tab with a dot.
 */
export function TabList<T extends string>({
  id,
  label,
  tabs,
  value,
  onChange,
  dotted,
}: {
  id: string;
  label: string;
  tabs: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
  dotted?: (key: T) => boolean;
}) {
  const row = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent, at: number) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = tabStep(e.key, at, tabs.length);
    if (next === null) return;
    e.preventDefault();
    onChange(tabs[next]![0]);
    row.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div class="tabs" role="tablist" aria-label={label} ref={row}>
      {tabs.map(([key, text], i) => (
        <button
          key={key}
          id={tabId(id, key)}
          type="button"
          role="tab"
          aria-selected={value === key}
          aria-controls={panelId(id)}
          tabIndex={value === key ? 0 : -1}
          class={`${value === key ? 'on' : ''}${dotted?.(key) ? ' tab-has' : ''}`}
          onClick={() => onChange(key)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  hideLabel,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  label: string;
  hideLabel?: boolean;
}) {
  return (
    <label class={`select${hideLabel ? ' select-bare' : ''}`}>
      <span class={hideLabel ? 'sr-only' : 'select-label'}>{label}</span>
      <select value={value} onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value as T)}>
        {options.map(([k, text]) => (
          <option key={k} value={k}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Empty({ icon: Icon, title, children }: { icon?: LucideIcon; title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      {Icon && <Icon size={22} aria-hidden="true" />}
      <p class="empty-title">{title}</p>
      {children && <div class="empty-body">{children}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd class="kbd">{children}</kbd>;
}

/** The ⌘ or Ctrl label for this computer. */
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+';
export const ALT = MOD === '⌘' ? '⌥' : 'Alt+';

/**
 * Moves focus to a panel's heading when the panel opens, so the keyboard and a screen reader start there, and gives it
 * back to where it was when the panel closes. Focus the person has moved somewhere else in the meantime stays there.
 * When `shows` changes while the panel stays open, as when a thread's Open swaps in the entry, the control that had
 * focus is gone with the old content, so focus goes to the heading again rather than to the page.
 */
function usePanelFocus(panel: RefObject<HTMLElement | null>, heading: RefObject<HTMLElement | null>, shows: string | undefined) {
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      return;
    }
    const now = document.activeElement;
    if (!now || now === document.body) heading.current?.focus({ preventScroll: true });
  }, [shows]);
  useEffect(() => {
    const box = panel.current;
    const active = document.activeElement;
    const back = active instanceof HTMLElement && active !== document.body && !box?.contains(active) ? active : null;
    heading.current?.focus({ preventScroll: true });
    return () => {
      const now = document.activeElement;
      const inPanel = !now || now === document.body || !!box?.contains(now);
      if (inPanel && back?.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
}

/**
 * A right-hand panel with a title and a close button. Escape closes it. Focus moves in when it opens and back when it
 * closes. `shows` names what the panel shows, for a panel whose content changes while it stays open.
 */
export function SidePanel({
  title,
  label,
  onClose,
  children,
  actions,
  wide,
  shows,
}: {
  title: ComponentChildren;
  label: string;
  onClose: () => void;
  children: ComponentChildren;
  actions?: ComponentChildren;
  wide?: boolean;
  shows?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-open')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  usePanelFocus(ref, heading, shows);
  return (
    <aside class={`side-panel${wide ? ' wide' : ''}`} aria-label={label} ref={ref}>
      <header class="side-head">
        <h2 class="side-title" tabIndex={-1} ref={heading}>
          {title}
        </h2>
        {actions}
        <Button icon={X} kind="quiet" aria-label="Close" title="Close (Esc)" onClick={onClose} />
      </header>
      <div class="side-body">{children}</div>
    </aside>
  );
}

/** Keeps focus inside an open dialog and gives it back when it closes. */
export function useFocusTrap(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !ref.current) return;
    const back = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const first = box.querySelector<HTMLElement>('[autofocus], input, button, [tabindex="0"]');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = [...box.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex="0"]')].filter(
        (el) => el.offsetParent !== null,
      );
      if (!items.length) return;
      const [a, z] = [items[0]!, items[items.length - 1]!];
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    box.addEventListener('keydown', onKey);
    return () => {
      box.removeEventListener('keydown', onKey);
      back?.focus?.();
    };
  }, [open]);
  return ref;
}
