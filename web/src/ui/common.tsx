// Small shared pieces: buttons, switches, segmented choices, empty states, the logo.

import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';
import { X } from 'lucide-preact';
import markDark from '../../../docs/brand/logo-mark-dark.svg';
import markLight from '../../../docs/brand/logo-mark.svg';
import { useApp } from '../store.ts';
import { theme } from '../themes.ts';

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

/** A right-hand panel with a title and a close button. Escape closes it. */
export function SidePanel({
  title,
  label,
  onClose,
  children,
  actions,
  wide,
}: {
  title: ComponentChildren;
  label: string;
  onClose: () => void;
  children: ComponentChildren;
  actions?: ComponentChildren;
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-open')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside class={`side-panel${wide ? ' wide' : ''}`} aria-label={label} ref={ref}>
      <header class="side-head">
        <div class="side-title">{title}</div>
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
