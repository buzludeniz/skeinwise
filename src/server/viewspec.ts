// The views API: the built-in and saved views, drawing a new one with the local model, a view's data, and saving and
// deleting. app.ts adds these routes to its own, so they pass the same Host, Origin, token and lock checks as every
// other route before they run. Every spec that arrives here is checked again, whoever sent it: a saved view, the
// model's answer and the page are all untrusted input.

import type { ModelDeps } from '../organiser/model.ts';
import { UsageError } from '../errors.ts';
import type { Store } from '../store/store.ts';
import { BUILTINS } from '../viewspec/builtins.ts';
import { resolveSpec, viewCell, viewData } from '../viewspec/data.ts';
import { drawState, drawView, REQUEST_LIMIT } from '../viewspec/draw.ts';
import { deleteView, listViews, MAX_SAVED, saveView, ViewNotFound } from '../viewspec/saved.ts';
import { checkSpecValue, type ViewSpec } from '../viewspec/spec.ts';
import { HttpError } from './app.ts';
import { entryRows } from './queries.ts';

export interface ViewRoutesContext {
  home: string;
  store: Store;
  deps: () => ModelDeps;
}

/** The part of app.ts's request a views route reads. */
export interface ViewReq {
  params: string[];
  json: () => Promise<Record<string, unknown>>;
}

export type ViewRoute = [string, RegExp, (req: ViewReq) => unknown];

const CELL_VALUE = 200;

function checked(value: unknown, doing: string): ViewSpec {
  const r = checkSpecValue(value);
  if (!r.ok) throw new HttpError(400, `That view can't be ${doing}. ${r.reasons.join(' ')}`);
  return r.spec;
}

/** One chart cell from the page: the x value and, for a chart with a y, the y value. */
function cellOf(value: unknown): { x: string; y: string | null } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'A cell is {x, y}.');
  const { x, y } = value as Record<string, unknown>;
  if (typeof x !== 'string' || x.length > CELL_VALUE) throw new HttpError(400, `A cell's x is text of up to ${CELL_VALUE} characters.`);
  if (y !== undefined && y !== null && (typeof y !== 'string' || y.length > CELL_VALUE)) throw new HttpError(400, `A cell's y is text of up to ${CELL_VALUE} characters, or null.`);
  return { x, y: typeof y === 'string' ? y : null };
}

export function viewRoutes(ctx: ViewRoutesContext): ViewRoute[] {
  const { home, store } = ctx;
  return [
    ['GET', /^\/api\/views$/, () => {
      let saved: ReturnType<typeof listViews> = { views: [], broken: [] };
      let problem: string | null = null;
      try {
        saved = listViews(home);
      } catch (error) {
        if (!(error instanceof UsageError)) throw error;
        problem = error.message;
      }
      return {
        builtins: BUILTINS.map((b) => ({ id: b.id, spec: b.spec })),
        saved: saved.views,
        broken: saved.broken,
        problem,
        ai: drawState(home),
        limits: { saved: MAX_SAVED, request: REQUEST_LIMIT },
      };
    }],
    ['POST', /^\/api\/views\/draw$/, async (req) => drawView(store, home, (await req.json()).request, ctx.deps())],
    ['POST', /^\/api\/views\/data$/, async (req) => {
      const body = await req.json();
      const spec = checked(body.spec, 'shown');
      const rows = entryRows(store.db);
      // A saved view may name a project or tag the record no longer has: it still shows, with the reason.
      const resolved = resolveSpec(spec, rows);
      const use = resolved.ok ? resolved.spec : spec;
      const notes = resolved.ok ? [] : resolved.reasons;
      if (body.cell !== undefined) {
        const cell = cellOf(body.cell);
        return { ...viewCell(rows, use, cell.x, cell.y), notes };
      }
      return { ...viewData(rows, use), spec: use, notes };
    }],
    ['POST', /^\/api\/views$/, async (req) => saveView(home, checked((await req.json()).spec, 'saved'))],
    ['POST', /^\/api\/views\/([^/]{1,80})\/delete$/, (req) => {
      const id = req.params[0] ?? '';
      try {
        deleteView(home, id);
      } catch (error) {
        if (error instanceof ViewNotFound) throw new HttpError(404, error.message);
        throw error;
      }
      return { deleted: id };
    }],
  ];
}
