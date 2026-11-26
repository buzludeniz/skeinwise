// The assistant's calls to the server (src/server/pa.ts), typed from the server's own modules so the two can't drift.
// A call that changes something tells the listeners, so the brief, the lists and the reminder bar refetch.

import { api, qs } from '../api.ts';
import type { Brief } from '../../../src/pa/brief.ts';
import type { Loop, LoopCounts, LoopState } from '../../../src/pa/loops.ts';
import type { LoopRead } from '../../../src/pa/model.ts';
import type { PaTask, TaskCounts, TaskPatch } from '../../../src/pa/tasks.ts';

export type { Brief, Loop, LoopState, PaTask };

export interface Today {
  day: string;
  brief: Brief | null;
  newSinceBrief: number;
  tasks: TaskCounts;
  reminders: PaTask[];
}

export interface LoopList {
  loops: Loop[];
  counts: LoopCounts;
  days: number | null;
  read: LoopRead | null;
  message: string | null;
}

export interface NewTask {
  text: string;
  dueDay?: string | null;
  remindAt?: string | null;
  reminder?: boolean;
}

const listeners = new Set<() => void>();

/** Calls `fn` after each change the assistant's calls make; returns the way to stop. */
export function onPaChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

async function changing<T>(call: Promise<T>): Promise<T> {
  const value = await call;
  listeners.forEach((f) => f());
  return value;
}

export const pa = {
  today: () => api.get<Today>('pa/today'),
  brief: () => changing(api.post<{ brief: Brief; message: string | null }>('pa/brief')),
  loops: (all: boolean) => api.get<LoopList>(`pa/loops${qs({ all: all ? 1 : null })}`),
  /** A model reads the sentences it hasn't yet, then the list comes back as GET loops gives it. */
  readLoops: (all: boolean) => changing(api.post<LoopList>('pa/loops/find', { all })),
  setLoop: (key: string, state: LoopState, until?: string) => changing(api.post<Loop>(`pa/loops/${key}`, { state, ...(until ? { until } : {}) })),
  loopTask: (key: string) => changing(api.post<PaTask>(`pa/loops/${key}/task`)),
  tasks: (all: boolean) => api.get<PaTask[]>(`pa/tasks${qs({ all: all ? 1 : null })}`),
  addTask: (task: NewTask) => changing(api.post<PaTask>('pa/tasks', task)),
  updateTask: (id: number, patch: TaskPatch) => changing(api.put<PaTask>(`pa/tasks/${id}`, patch)),
  deleteTask: (id: number) => changing(api.post<PaTask>(`pa/tasks/${id}/delete`)),
  reminders: () => api.get<{ due: PaTask[]; upcoming: PaTask[] }>('pa/reminders'),
  dismiss: (id: number) => changing(api.post<PaTask>(`pa/reminders/${id}/dismiss`)),
  snooze: (id: number, until: string) => changing(api.post<PaTask>(`pa/reminders/${id}/snooze`, { until })),
};
