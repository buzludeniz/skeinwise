// What a task hands the runner: the model requests it needs (none for the No-AI engine) and a finish step that turns
// the checked answers into rows. Planning everything first lets a run show what it would send, estimate its size and
// stay inside a budget before it calls anything.

import type { DatabaseSync } from 'node:sqlite';
import { safeBlock, safeLine } from '../safe-text.ts';
import type { Entry } from '../store/store.ts';
import type { RecordView } from './record.ts';
import type { Scope } from './runs.ts';

export interface ModelRequest {
  /** What the request is for, as shown in progress lines, previews and errors ("hub 3 of 8"). */
  purpose: string;
  system: string;
  user: string;
  maxTokens: number;
  /** Checks a parsed answer and returns it in the shape finish expects; throws when it doesn't fit. */
  check: (answer: unknown) => unknown;
}

export interface Product {
  counts: Record<string, number>;
  message?: string;
  /** Writes the rows; runs inside the transaction that marks the run done. */
  save: (db: DatabaseSync, runId: number) => void;
}

export interface Plan {
  requests: ModelRequest[];
  /** Gets one checked answer per request, in order. */
  finish: (answers: unknown[]) => Product;
}

export interface TaskContext {
  db: DatabaseSync;
  record: RecordView;
  scope: Scope;
  /** The visible entries in scope. */
  entries: Entry[];
  /** True when a model does the judgement; false for the No-AI engine. */
  model: boolean;
  /** The engine and model name the run records. */
  engine: 'none' | 'local' | 'remote';
  modelName: string | null;
  now: string;
}

/** A plan with no model requests. */
export function direct(product: () => Product): Plan {
  return { requests: [], finish: () => product() };
}

export function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** The YYYY-MM-DD part of an ISO date. */
export function day(iso: string): string {
  return iso.slice(0, 10);
}

/** Throws a checking error that names the request, so a failed run says which answer was wrong. */
export function invalid(purpose: string, why: string): never {
  throw new Error(`The model's answer for ${purpose} doesn't fit: ${why}`);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A non-empty string, trimmed, at most max characters. */
/**
 * A model's text field, trimmed and made safe to store and print: escape sequences, controls and bidi overrides go
 * (`safeLine`; `safeBlock` keeps line breaks), so an answer can't hide a link or rewrite the screen later.
 */
export function text(purpose: string, v: unknown, field: string, max = 2000, shape: 'line' | 'block' = 'line'): string {
  const t = typeof v === 'string' ? (shape === 'block' ? safeBlock(v) : safeLine(v)).trim() : '';
  if (!t) invalid(purpose, `"${field}" must be non-empty text`);
  if (t.length > max) invalid(purpose, `"${field}" is longer than ${max} characters`);
  return t;
}

export function list(purpose: string, v: unknown, field: string): unknown[] {
  if (!Array.isArray(v)) invalid(purpose, `"${field}" must be a list`);
  return v;
}

/**
 * Reads ids the model cites, like "E12" or "S3", and checks each is one it was shown. Accepts bare numbers too,
 * since small models often drop the letter.
 */
export function cited(purpose: string, v: unknown, field: string, prefix: string, known: ReadonlyMap<string, number>): number[] {
  const out: number[] = [];
  for (const item of list(purpose, v, field)) {
    const key = typeof item === 'number' ? `${prefix}${item}` : typeof item === 'string' ? item.trim().toUpperCase() : '';
    const id = known.get(/^\d+$/.test(key) ? `${prefix}${key}` : key);
    if (id === undefined) invalid(purpose, `"${field}" cites ${JSON.stringify(item)}, which it wasn't shown`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** What goes over the wire for one request. */
export interface Sent {
  system: string;
  user: string;
}

/** A model server the runner talks to. model.ts makes one from the settings. */
export interface ModelClient {
  engine: 'local' | 'remote';
  /** The model's name as the run records it. Empty for a local server until probe picks the first model it lists. */
  model: string;
  /** The server's base URL. */
  url: string;
  /** True when requests are redacted before they leave this computer. */
  redacts: boolean;
  /** The text a request would send: redacted when the server is not on this computer and redaction is on. */
  prepare: (request: ModelRequest) => Sent;
  /** Checks the server answers; throws a message that says how to start one. */
  probe: () => Promise<void>;
  /**
   * Sends one request and returns the parsed JSON answer (with redactions put back) and the tokens used. An answer
   * that can't be read throws an AnswerError, which still carries the tokens it used.
   */
  send: (request: ModelRequest) => Promise<{ answer: unknown; tokensIn: number; tokensOut: number }>;
}

/** A model answer that came back but can't be used (not JSON, cut off). The tokens were spent all the same. */
export class AnswerError extends Error {
  tokensIn = 0;
  tokensOut = 0;
}

/** How a client is named in messages before its model is known. */
export function modelLabel(client: ModelClient): string {
  return client.model || `the first model at ${client.url}`;
}
