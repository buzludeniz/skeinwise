// `skeinwise mcp` as the CLI would run it, for the stdio test: the record folder from SKEINWISE_HOME, the command
// from MCP_COMMANDS, stdout for the protocol and stderr for everything else. `--window` serves the window tools.

import type { Ctx } from '../../../src/cli-organiser.ts';
import { homeDir, openHome } from '../../../src/home.ts';
import { MCP_COMMANDS } from '../../../src/mcp/commands.ts';

const home = homeDir(process.env);
const store = openHome(home);
const ctx: Ctx = {
  io: { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t), env: process.env },
  home,
  store,
  values: { window: process.argv.includes('--window') } as Ctx['values'],
  args: [],
  json: (v) => process.stdout.write(`${JSON.stringify(v)}\n`),
};
try {
  process.exitCode = await MCP_COMMANDS.mcp!(ctx);
} finally {
  store.db.close();
}
