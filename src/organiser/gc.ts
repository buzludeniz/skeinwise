// A full garbage collection between the steps of a run that holds the whole record: `skeinwise run all` and the app's
// Organise. Each step builds and drops hundreds of MB. After a mark-compact, V8 lets the heap grow to about four times
// what was live before it collects again, so where a step's garbage goes depends on where the last collection fell. At
// 50,000 entries the Topics step leaves about 123 MB live, and the garbage of the next five steps piled up to 552 MB of
// heap before V8 collected it (Mac, Node 26, --trace-gc). Hosted, run all's peak read 842 MB against main's 730: main's
// slower Projects scan made enough garbage to force a collection early. With a collection between steps, the peak is
// the largest step's, not the luck of where V8's limit falls.

import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

let found: (() => void) | null | undefined;

/**
 * V8's gc, had without a command-line flag: globalThis.gc under --expose-gc, else the one a new context gets while the
 * flag is set at run time. Null when neither is there, and the run goes on without it.
 */
export function fullGc(): (() => void) | null {
  if (found === undefined) {
    const own: unknown = (globalThis as { gc?: unknown }).gc;
    if (typeof own === 'function') found = own as () => void;
    else {
      setFlagsFromString('--expose-gc');
      const made: unknown = runInNewContext('typeof gc === "function" ? gc : null');
      // Only that one context keeps it: contexts made later don't get a gc of their own.
      setFlagsFromString('--no-expose-gc');
      found = typeof made === 'function' ? (made as () => void) : null;
    }
  }
  return found;
}

/** Collects all the garbage now, when V8's gc can be had. True when it ran. */
export function collectGarbage(): boolean {
  const gc = fullGc();
  gc?.();
  return gc !== null;
}
