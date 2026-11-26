// The performance budgets of the v1 plan (section 7.2), set for an M1 with 16 GB, and the verdict on a bench run.
// Memory is resident memory in MB of 1024 x 1024 bytes; transfer sizes are in kB of 1000 bytes, as Vite prints them;
// an MCP reply's size is in KB of 1024 bytes.

export type Size = '50k' | '150k';

export const SIZES: Record<Size, number> = { '50k': 50_000, '150k': 150_000 };

export type Unit = 'ms' | 'MB' | 'kB' | 'KB';

export interface Budget {
  key: string;
  label: string;
  unit: Unit;
  /** The most a run may take at each size; null where the plan sets none. */
  limit: Record<Size, number | null>;
}

/** The CLI's ask budget. An MCP ask takes it too: with engine none it is the same work as `ask --engine none`. */
const ASK_LIMIT: Record<Size, number> = { '50k': 1_000, '150k': 3_000 };

export const BUDGETS: Budget[] = [
  { key: 'import.time', label: 'Import (cold)', unit: 'ms', limit: { '50k': 8_000, '150k': 25_000 } },
  { key: 'import.memory', label: 'Import peak memory', unit: 'MB', limit: { '50k': 600, '150k': 1024 } },
  { key: 'search.p95', label: 'search p95', unit: 'ms', limit: { '50k': 150, '150k': 300 } },
  { key: 'ask.time', label: 'ask --engine none (slowest)', unit: 'ms', limit: ASK_LIMIT },
  { key: 'similar.time', label: 'similar (slowest)', unit: 'ms', limit: { '50k': 1_000, '150k': 2_000 } },
  { key: 'runAll.time', label: 'First run all --engine none', unit: 'ms', limit: { '50k': 180_000, '150k': 720_000 } },
  { key: 'runAll.memory', label: 'First run all peak memory', unit: 'MB', limit: { '50k': 800, '150k': 1.2 * 1024 } },
  { key: 'incremental.time', label: 'Organise 100 new entries', unit: 'ms', limit: { '50k': 10_000, '150k': 20_000 } },
  { key: 'live.searchable', label: 'Live: file write to searchable', unit: 'ms', limit: { '50k': 5_000, '150k': 5_000 } },
  { key: 'live.idle', label: 'Live idle memory', unit: 'MB', limit: { '50k': 150, '150k': 200 } },
  { key: 'brain.gzip', label: '/api/brain first load (gzip)', unit: 'kB', limit: { '50k': 600, '150k': 1_500 } },
  { key: 'web.js', label: 'Web initial JS (gzip)', unit: 'kB', limit: { '50k': 250, '150k': 250 } },
  // Plan 7.2's MCP call p95 counts the lookup tools (search, timeline, list_hubs, read_hub, …), and an MCP ask is
  // measured on its own against the CLI's ask budget. With 3 asks among 17 calls, the nearest-rank p95 was an ask every
  // time. Split for the 1.0 gate.
  { key: 'mcp.p95', label: 'MCP lookup p95 (asks apart)', unit: 'ms', limit: { '50k': 200, '150k': 400 } },
  { key: 'mcp.ask', label: 'MCP ask (slowest)', unit: 'ms', limit: ASK_LIMIT },
  { key: 'mcp.size', label: 'MCP largest reply', unit: 'KB', limit: { '50k': 32, '150k': null } },
  { key: 'demo.time', label: 'demo build', unit: 'ms', limit: { '50k': 1_000, '150k': null } },
];

/** Budgets the bench can't measure, printed so the list stays whole. */
export const UNMEASURED = [
  { label: 'Brain frame rate', budget: '60 fps at 5k visible points (M1); 30 fps on Intel integrated graphics', why: 'needs a browser and a GPU' },
];

/** What one measure gave: a value, or why there is none. */
export type Result = { value: number; note?: string } | { error: string };

export interface Row {
  budget: Budget;
  result: Result | undefined;
  limit: number | null;
  /** ok, over, failed (the measure broke or never ran), or none (no budget at this size). */
  verdict: 'ok' | 'over' | 'failed' | 'none';
}

export function judge(size: Size, results: Map<string, Result>): Row[] {
  return BUDGETS.map((budget) => {
    const result = results.get(budget.key);
    const limit = budget.limit[size];
    let verdict: Row['verdict'];
    if (!result || 'error' in result) verdict = 'failed';
    else if (limit === null) verdict = 'none';
    else verdict = result.value <= limit ? 'ok' : 'over';
    return { budget, result, limit, verdict };
  });
}

/** The nearest-rank percentile of a list of numbers. */
export function percentile(values: number[], p: number): number {
  if (!values.length) throw new Error('No values to take a percentile of.');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;
}

export function show(value: number, unit: Unit): string {
  if (unit === 'ms') return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)} s` : `${Math.round(value)} ms`;
  if (unit === 'MB' && value >= 1024) return `${(value / 1024).toFixed(2)} GB`;
  if (unit === 'kB' && value >= 1_000) return `${(value / 1_000).toFixed(2)} MB`;
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

/** The report as plain lines: no colour and no box drawing, so it reads the same in a CI log and a screen reader. */
export function report(size: Size, rows: Row[]): string {
  const lines = [`${'Measure'.padEnd(34)}${'Result'.padEnd(14)}${'Budget'.padEnd(12)}Verdict`];
  for (const r of rows) {
    const got = !r.result ? 'not run' : 'error' in r.result ? 'failed' : show(r.result.value, r.budget.unit);
    const budget = r.limit === null ? 'none' : show(r.limit, r.budget.unit);
    const extra = !r.result ? '' : 'error' in r.result ? `: ${r.result.error}` : r.result.note ? ` (${r.result.note})` : '';
    lines.push(`${r.budget.label.padEnd(34)}${got.padEnd(14)}${budget.padEnd(12)}${r.verdict}${extra}`);
  }
  for (const u of UNMEASURED) lines.push(`${u.label.padEnd(34)}${'not measured'.padEnd(14)}${u.budget} (${u.why})`);
  const bad = rows.filter((r) => r.verdict === 'over' || r.verdict === 'failed');
  lines.push('');
  lines.push(
    bad.length
      ? `${bad.length} of ${rows.length} measures over budget or failed at ${size}: ${bad.map((r) => r.budget.label).join('; ')}.`
      : `Every measure within budget at ${size}.`,
  );
  return `${lines.join('\n')}\n`;
}
