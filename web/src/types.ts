// The API's shapes, taken straight from the server's modules so the two can't drift.
// The server still calls the Stats figures `Numbers` and a Profile line `YouLine`; the page uses its own names.
export type { Brief, BrainData, BrainPoint, EntryDetail, Numbers as Stats, YouLine as ProfileLine } from '../../src/server/queries.ts';
export type { EntryLines, EntryOrganised, HubDetail, LineCounts, OrganiseJob, OrganiserState } from '../../src/server/organiser.ts';
export type { AskHit, AskKind, AskResult } from '../../src/organiser/ask.ts';
export type { AskStreamEvent } from '../../src/server/ask-stream.ts';
export type { Folder, Hub, HubItem, HubSections, Layer, LayerName, Reason, ReviewItem } from '../../src/organiser/views.ts';
export type { Run, Task } from '../../src/organiser/runs.ts';
export type { Config, LabView } from '../../src/server/config.ts';
export type { Timeline, Table, Series, TableProp, EntryRow } from '../../src/server/buckets.ts';
export type { Found, Preview, Agent } from '../../src/server/found.ts';
export type { McpRequest as AgentRequest } from '../../src/mcp/requests.ts';
export type { Entry, Version, Source, Thread } from '../../src/store/store.ts';
import type { LiveState } from '../../src/server/live.ts';
export type { LiveState };

export interface Status {
  version: string;
  locked: boolean;
  entries: number;
  lastSaved: string | null;
  organiser: boolean;
  /** Live capture: whether the stream runs, and its two status lines. */
  live: LiveState;
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
  /**
   * Only when the server held the batch back, because its export claims another account than its source's: nothing
   * came in, and the changes wait for a yes as pending #pendingId. A null pendingId means this file was proposed before.
   */
  proposed?: number;
  pendingId?: number | null;
}
