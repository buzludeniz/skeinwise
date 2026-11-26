// The first run lists what Skeinwise uses. Agent memory over MCP ships in 1.0, so its line names the command that
// connects an agent, in the words Settings uses (web/src/ui/Settings.tsx), and is never marked as still to come.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'src', 'views', 'FirstRun.tsx'), 'utf8');

describe("the first run's agent servers line", () => {
  it('names the command that connects an agent, and the agents it knows, as Settings does', () => {
    const words = src.replace(/\s+/g, ' ');
    expect(words).toContain('run <code>skeinwise connect claude-code</code> in a terminal,');
    expect(words).toContain('with codex, cursor or claude-desktop in place of claude-code for the others.');
  });

  it('marks the servers as there, not as a version still to come', () => {
    expect(src).toContain("mark('servers', 'done')");
    expect(src).not.toMatch(/come in version/);
    expect(src).not.toMatch(/mark\('servers', '(later|wait)'\)/);
  });
});
