// Calls to the local server. The token arrives once in the address's #fragment, is kept in this page's memory only, and
// goes with every call in a header. Nothing stores it, so a script or extension that reads storage finds no token, and
// a reload asks for the address `skeinwise serve` printed, which carries a new token each start anyway (L9).

/** Where builds before L9 kept the token; boot removes it, so no old token stays in the browser. */
const OLD_KEY = 'skeinwise.token';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let token: string | null = null;
const listeners = { locked: new Set<() => void>(), unauthorised: new Set<() => void>() };

/** Takes the token from #token=… and clears it from the address bar, so it stays out of history and bookmarks. */
export function initToken(): string | null {
  try {
    localStorage.removeItem(OLD_KEY);
  } catch {
    // Storage may be blocked, and then nothing was kept there.
  }
  const m = /(?:^|[#&])token=([0-9a-f]{64})/.exec(location.hash);
  if (m) {
    token = m[1]!;
    history.replaceState(null, '', location.pathname + location.search);
  }
  return token;
}

export function onLocked(fn: () => void): void {
  listeners.locked.add(fn);
}

export function onUnauthorised(fn: () => void): void {
  listeners.unauthorised.add(fn);
}

async function call<T>(method: string, path: string, body?: unknown, raw?: BodyInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers['X-Skeinwise-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (raw !== undefined) headers['Content-Type'] = 'application/octet-stream';
  const res = await fetch(`/api/${path}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON: fall through to the status check.
  }
  if (!res.ok) refuse(res.status, data);
  return data as T;
}

/** Throws the server's refusal, after telling whoever waits for a lock or a lost token. */
function refuse(status: number, data: unknown): never {
  if (status === 423) listeners.locked.forEach((f) => f());
  if (status === 401) listeners.unauthorised.forEach((f) => f());
  throw new ApiError(status, (data as { error?: string } | null)?.error ?? `The server answered ${status}`);
}

/**
 * A GET answered with server-sent events (GET /api/ask/stream): `onEvent` gets each one as it arrives, and the call
 * ends with the stream. EventSource can't send the token header, so this reads the body itself. Aborting `signal`
 * closes the connection, which stops the server's work, and rejects with the AbortError.
 */
async function stream<E>(path: string, onEvent: (event: E) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api/${path}`, { headers: token ? { 'X-Skeinwise-Token': token } : {}, signal });
  if (!res.ok) refuse(res.status, await res.json().catch(() => null));
  if (!res.body) throw new ApiError(res.status, 'The server sent nothing back');
  await readEvents(res.body, onEvent);
}

/** Reads `data: <json>` events, each ended by a blank line, out of a body as it arrives. */
export async function readEvents<E>(body: ReadableStream<Uint8Array>, onEvent: (event: E) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.replace(/^data: ?/, ''))
        .join('\n');
      buffer = buffer.slice(end + 2);
      if (data) onEvent(JSON.parse(data) as E);
    }
  }
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
  upload: <T>(path: string, file: Blob) => call<T>('POST', path, undefined, file),
  stream: <E>(path: string, onEvent: (event: E) => void, signal?: AbortSignal) => stream<E>(path, onEvent, signal),
};

/** Builds a query string, skipping empty values. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
