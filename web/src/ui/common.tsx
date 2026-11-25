// Small shared pieces: buttons, switches, segmented choices, empty states, the logo.

import type { ButtonHTMLAttributes, ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type { LucideIcon } from 'lucide-preact';
import { X } from 'lucide-preact';

/** Our mark: a wound skein whose loose end runs off as a thread. */
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
    >
      <circle cx="14" cy="14" r="10" />
      <path d="M6.2 8.4c4.6 1.4 10.4 6.6 12.6 14.2" />
      <path d="M10.4 4.8c3.4 3 7.6 9.4 8.6 17.6" opacity="0.7" />
      <path d="M4.2 14.6c5-.6 12.4 2.2 17.4 6.8" />
      <path d="M21.6 21.4c1.2 2.4 2.6 5.6 5.4 5.6 1.4 0 2.2-.8 2.4-2" />
    </svg>
  );
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
