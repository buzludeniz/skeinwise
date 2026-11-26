// Reminders while the app is open. One watcher asks the server every minute (and when the tab comes back into view)
// what is due; the bar shows it with Done, Snooze and Dismiss. Nothing runs while the app is closed, and the app says
// so where reminders are set.

import { useEffect, useState } from 'preact/hooks';
import { BellRing, Check, Clock, X } from 'lucide-preact';
import { message, toast } from '../actions.ts';
import { useApp } from '../store.ts';
import { Button } from '../ui/common.tsx';
import { onPaChange, pa, type PaTask } from './api.ts';
import { fmtRemind, snoozeChoices } from './text.ts';

const POLL_MS = 60_000;

let due: PaTask[] = [];
const listeners = new Set<() => void>();
let watchers = 0;
let stopWatch: (() => void) | null = null;

/** Asks the server what is due now. */
export async function checkReminders(): Promise<void> {
  try {
    due = (await pa.reminders()).due;
  } catch {
    // Locked, offline or quitting: the lock screen and the status check say so, and the next poll tries again.
    return;
  }
  listeners.forEach((f) => f());
}

function startWatch(): () => void {
  const visible = () => document.visibilityState === 'visible';
  const onShow = () => visible() && void checkReminders();
  const timer = setInterval(onShow, POLL_MS);
  document.addEventListener('visibilitychange', onShow);
  const unlisten = onPaChange(() => void checkReminders());
  void checkReminders();
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onShow);
    unlisten();
  };
}

/** The reminders due now, kept current while any component using this is mounted. */
export function useDueReminders(): PaTask[] {
  const [list, setList] = useState(due);
  useEffect(() => {
    const update = () => setList(due);
    listeners.add(update);
    if (watchers++ === 0) stopWatch = startWatch();
    update();
    return () => {
      listeners.delete(update);
      if (--watchers === 0) {
        stopWatch?.();
        stopWatch = null;
      }
    };
  }, []);
  return list;
}

function act(call: Promise<unknown>, done: string): void {
  call.then(
    () => toast(done),
    (error: unknown) => toast(message(error), { tone: 'error' }),
  );
}

/** The due reminders, over every view. Mount it once, in App. */
export function ReminderBar() {
  const list = useDueReminders();
  const locked = useApp((s) => s.locked);
  if (locked || !list.length) return null;
  const now = new Date();
  return (
    <section class="pa-reminders" aria-label="Reminders due">
      <h2 class="sr-only">Reminders due</h2>
      <ul aria-live="polite">
        {list.map((t) => (
          <li key={t.id} class="pa-reminder">
            <BellRing size={16} aria-hidden="true" class="pa-bell" />
            <span class="pa-reminder-text">
              <strong>{t.title}</strong>
              <span class="soft small"> {fmtRemind(t.remindAt!, now)}</span>
            </span>
            <span class="pa-reminder-actions">
              <Button small kind="quiet" icon={Check} aria-label={`Done: ${t.title}`} onClick={() => act(pa.updateTask(t.id, { status: 'done' }), `Done: ${t.title}`)}>
                Done
              </Button>
              {snoozeChoices(now)
                .slice(0, 2)
                .map((c) => (
                  <Button
                    key={c.label}
                    small
                    kind="quiet"
                    icon={Clock}
                    aria-label={`Snooze ${c.label}: ${t.title}`}
                    onClick={() => act(pa.snooze(t.id, c.until), `Snoozed for ${c.label}: ${t.title}`)}
                  >
                    {c.label}
                  </Button>
                ))}
              <Button small kind="quiet" icon={X} aria-label={`Dismiss the reminder: ${t.title}`} title="Dismiss" onClick={() => act(pa.dismiss(t.id), `Dismissed: ${t.title}`)} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
