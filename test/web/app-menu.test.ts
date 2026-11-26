// The app menu's Connect points at `skeinwise connect <agent>`, which writes the agent's MCP config (src/connect.ts).
// The page can't do that itself, so the menu names the command, and each agent it lists must be one connect knows.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CLIENTS } from '../../src/connect.ts';
import { findAgents } from '../../src/server/found.ts';

describe("the app menu's Connect", () => {
  it('lists only agents that skeinwise connect can set up', () => {
    const known = AGENT_CLIENTS.map((c) => c.key);
    const listed = findAgents(join(import.meta.dirname, 'no-such-home')).map((a) => a.key);
    expect(listed.length).toBeGreaterThan(0);
    for (const key of listed) expect(known).toContain(key);
  });

  it('names the command for the agent, not a version still to come', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'src', 'ui', 'AppMenu.tsx'), 'utf8');
    expect(src).toContain('skeinwise connect ${a.key}');
    expect(src).not.toMatch(/come in version/);
  });
});
