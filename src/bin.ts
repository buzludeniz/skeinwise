#!/usr/bin/env node
// The `skeinwise` command (package.json's bin). It checks the Node version before src/cli.ts loads node:sqlite, so an
// old Node gets a clear message instead of a stack trace. Its one static import is node-check.ts, which imports
// nothing; test/bin.test.ts holds both files to that. cli.ts still runs on its own (`node dist/src/cli.js`).
import { oldNodeMessage } from './node-check.ts';

const tooOld = oldNodeMessage(process.versions.node);
if (tooOld) {
  process.stderr.write(tooOld);
  process.exitCode = 1;
} else {
  const { main } = await import('./cli.ts');
  process.exitCode = await main(process.argv.slice(2));
}
