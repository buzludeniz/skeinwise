// The API's shapes, taken straight from the server's modules so the two can't drift.
export type { Brief, BrainData, BrainPoint, EntryDetail, AskView, Numbers, YouLine } from '../../src/server/queries.ts';
export type { Config, LabView } from '../../src/server/config.ts';
export type { Timeline, Table, Series, TableProp, EntryRow } from '../../src/server/buckets.ts';
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

// The organiser's shapes, as main's src/organiser/views.ts gives them. They live here until main is merged into this
// branch; then they come from the server like the rest.

export interface HubItem {
  text: string;
  entryId: number;
  date: string;
  cites?: number[];
}

export interface HubSections {
  in_short: HubItem[];
  what_you_found: HubItem[];
  open_ends: HubItem[];
}

export interface Hub {
  id: number;
  name: string;
  runId: number;
  replaces: number | null;
  sections: HubSections;
  entries: number[];
}

export interface Folder {
  id: number;
  name: string;
  aliases: string[];
  entryIds: number[];
}

export type LayerName = 'cleaned' | 'expanded' | 'digest' | 'ideas';

export interface Layer {
  layer: LayerName;
  body: string;
  engine: string;
  model: string | null;
  runId: number;
}

export interface Reason {
  entryId: number;
  date: string;
  quote: string;
  why: string;
}

export interface ReviewItem {
  id: number;
  noteEntry: number;
  reasons: Reason[];
  status: 'open' | 'updated' | 'holds' | 'skipped';
  proposed: string;
  runId: number;
}

export interface Run {
  id: number;
  task: 'tag' | 'file' | 'link' | 'hub' | 'layer' | 'review' | 'ask' | 'correction';
  engine: 'none' | 'local' | 'remote' | 'you';
  model: string | null;
  scope: string;
  schemaId: string;
  status: 'running' | 'done' | 'failed' | 'undone';
  counts: Record<string, number>;
  message: string | null;
  detail: string | null;
  mark: string | null;
  tokensIn: number;
  tokensOut: number;
  startedAt: string;
  finishedAt: string | null;
}

