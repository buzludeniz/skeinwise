/** A mistake in how a command was called, or a request the record can't meet as asked. The CLI exits with 2. */
export class UsageError extends Error {}

/** A whole number of at least 1 from the command line: an entry, a run, a hub, a limit. */
export function needId(value: string | undefined, what: string): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n < 1) throw new UsageError(`Give a ${what} number, for example: 12`);
  return n;
}
