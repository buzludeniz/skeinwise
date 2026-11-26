import { defineConfig } from 'vitest/config';

// Coverage (plan 7.1), measured with V8's own counters by `pnpm coverage` and the CI coverage job. It covers the
// command line and the server in src/. The web app is checked by the Playwright e2e and axe instead. Below these
// lines, the run fails:
// - 80% of lines in each of the parts that read untrusted input or hold the record: importers, store, live, mcp,
//   server, and fsafe.ts once it lands (a pattern that matches no file is skipped);
// - 70% of lines over all of src/.
//
// Windows gets longer time limits. Its CI runners are several times slower and vary from run to run: on 07cb338, four
// tests that pass in a second or two elsewhere went past vitest's 5 s, and a sync hook past 10 s. The same commit
// passed every test in the run before. Elsewhere the defaults stay, so a test that has grown slow still fails there.
const windows = process.platform === 'win32';

export default defineConfig({
  test: {
    ...(windows ? { testTimeout: 30_000, hookTimeout: 60_000 } : {}),
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: {
        lines: 70,
        'src/importers/**': { lines: 80 },
        'src/store/**': { lines: 80 },
        'src/live/**': { lines: 80 },
        'src/mcp/**': { lines: 80 },
        'src/server/**': { lines: 80 },
        'src/fsafe.ts': { lines: 80 },
      },
    },
  },
});
