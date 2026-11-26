// The agent-request card in Settings shows each request's `what` as text: it carries a thread title from the record,
// which an agent misled by text in the record may have written. Confirm, refuse, a request that can no longer be made
// and where focus goes are in e2e/smoke.e2e.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the agent-request card', () => {
  it('never puts a request into the page as markup', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'web', 'src', 'ui', 'AgentRequests.tsx'), 'utf8');
    expect(src).toContain('{r.what}');
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/);
  });
});
