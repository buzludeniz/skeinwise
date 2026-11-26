// The views API's shapes, taken from the server's own types so the page and the server can't drift apart.

import type { ViewData, ListItem } from '../../../src/viewspec/data.ts';
import type { BrokenView, SavedView } from '../../../src/viewspec/saved.ts';
import type { ViewSpec } from '../../../src/viewspec/spec.ts';

export type { Drawn } from '../../../src/viewspec/draw.ts';
export type { ListItem, ViewData } from '../../../src/viewspec/data.ts';
export type { BrokenView, SavedView } from '../../../src/viewspec/saved.ts';
export type { ChartSpec, ListSpec, ViewForm, ViewSpec } from '../../../src/viewspec/spec.ts';

/** GET /api/views */
export interface ViewsIndex {
  builtins: { id: string; spec: ViewSpec }[];
  saved: SavedView[];
  broken: BrokenView[];
  /** Why the saved views couldn't be read at all (the views folder is a link, say). */
  problem: string | null;
  ai: { draws: boolean; engine: string; note: string | null };
  limits: { saved: number; request: number };
}

/** POST /api/views/data with a spec */
export type ViewDataReply = ViewData & { spec: ViewSpec; notes: string[] };

/** POST /api/views/data with a spec and a cell */
export interface CellReply {
  total: number;
  entries: ListItem[];
  notes: string[];
}
