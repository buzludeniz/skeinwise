// The API's shapes, taken straight from the server's modules so the two can't drift.
export type { Brief, BrainData, BrainPoint, EntryDetail, AskView, Numbers, YouLine } from '../../src/server/queries.ts';
export type { Config, LabView } from '../../src/server/config.ts';
export type { Timeline, Table, Series, TableProp } from '../../src/server/buckets.ts';
export type { Found, Preview, Agent } from '../../src/server/found.ts';
export type { Entry, Version, Source, Thread } from '../../src/store/store.ts';

export interface Status {
  version: string;
  locked: boolean;
  entries: number;
  lastSaved: string | null;
  organiser: boolean;
}

export interface Hit {
  id: number;
  kind: string;
  speaker: string;
  title: string;
  createdAt: string;
  sourceLabel: string;
  threadTitle: string | null;
  snippet: string;
  threadId: number | null;
}

export interface ImportResult {
  source: string;
  kind: string;
  added: number;
  versioned: number;
  unchanged: number;
  threads: number;
}
