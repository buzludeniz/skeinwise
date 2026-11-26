// GET /api/ask/stream: a question whose answer arrives as the model writes it, as server-sent events. The page reads
// it with fetch (it sends the token header, which EventSource can't) and shows, in order:
//
//   {"type":"hits","result":…}     the entries found, at once, before the model is asked (an AskResult, No-AI)
//   {"type":"status","line":…}     what the model is doing, in a few words
//   {"type":"text","text":…}       the next piece of the answer, already cleaned: append it
//   {"type":"restart","why":…}     the answer couldn't be used and is asked for again: clear the text shown
//   {"type":"done","result":…}     the checked answer (an AskResult): it replaces what was streamed
//   {"type":"error","message":…}   the ask stopped; the entries shown stay
//
// Closing the connection stops the model (llama-server stops writing when its own connection closes) and records the
// run as stopped. A model that can't be reached ends, like /api/ask, with the entries alone and a line that says why.
// Anything wrong before the stream starts (an empty question, an unknown engine) throws, so the app answers it as JSON
// with a status.

import type { ServerResponse } from 'node:http';
import { UsageError } from '../errors.ts';
import { readNotes } from '../notes.ts';
import { ask, type AskResult, parseQuestion } from '../organiser/ask.ts';
import { type ModelDeps, ModelCancelledError } from '../organiser/model.ts';
import { RecordView } from '../organiser/record.ts';
import type { Store } from '../store/store.ts';
import { pickEngine } from './organiser.ts';

export type AskStreamEvent =
  | { type: 'hits'; result: AskResult }
  | { type: 'status'; line: string }
  | { type: 'text'; text: string }
  | { type: 'restart'; why: string }
  | { type: 'done'; result: AskResult }
  | { type: 'error'; message: string };

export interface AskStreamInput {
  store: Store;
  home: string;
  question: string;
  /** The engine asked for (?engine=), or undefined for the one in the settings. */
  engine: unknown;
  deps: ModelDeps;
  limit?: number;
}

export async function streamAsk(res: ServerResponse, input: AskStreamInput): Promise<void> {
  const { store, home, question, deps, limit = 20 } = input;
  parseQuestion(question);
  const { engine, client, budget } = pickEngine(home, input.engine, deps);
  readNotes(store, home);
  const record = new RecordView(store);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const stop = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) stop.abort();
  });
  const send = (event: AskStreamEvent) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    const result = await ask(store, record, question, { engine, ...(client ? { client } : {}), budget, limit }, {
      onHits: (r) => send({ type: 'hits', result: r }),
      onStatus: (line) => send({ type: 'status', line }),
      onText: (text) => send({ type: 'text', text }),
      onRestart: (why) => send({ type: 'restart', why }),
      signal: stop.signal,
    });
    send({ type: 'done', result });
  } catch (error) {
    // Stopped: whoever stopped it has gone.
    if (!(error instanceof ModelCancelledError)) send(await fallback(error));
  } finally {
    res.end();
  }

  async function fallback(error: unknown): Promise<AskStreamEvent> {
    const why = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError && /budget|cap/i.test(why)) return { type: 'error', message: why };
    try {
      const plain = await ask(store, record, question, { engine: 'none', budget, limit });
      return { type: 'done', result: { ...plain, message: `The ${engine} model didn't answer, so these are your entries alone. ${why}` } };
    } catch (again) {
      return { type: 'error', message: again instanceof Error ? again.message : String(again) };
    }
  }
}
