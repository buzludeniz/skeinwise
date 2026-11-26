// Settings shows no promise of a later version, no field that nothing reads, and says when entries leave this computer.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CLIENTS } from '../../src/connect.ts';

const settings = readFileSync(join(import.meta.dirname, '..', '..', 'web/src/ui/Settings.tsx'), 'utf8');

describe('Settings', () => {
  it('promises no later version', () => {
    expect(settings).not.toMatch(/comes in version|version 0\.\d/i);
  });

  it('has no Sync group, since nothing reads its folder', () => {
    expect(settings).not.toMatch(/'Sync'|title="Sync"|config\.sync\b|saveConfig\(\{ sync/);
  });

  it('has no Proof of date switch and no daily backup switch, since 1.0 does neither; the on-demand backup stays', () => {
    expect(settings).not.toMatch(/'Proof of date'|title="Proof of date"|config\.proofOfDate|saveConfig\(\{ proofOfDate/);
    expect(settings).not.toMatch(/config\.backup\.daily|saveConfig\(\{ backup: \{ daily|Back up every day/);
    expect(settings).not.toMatch(/not available yet/i);
    expect(settings).toContain('<Group title="Backup">');
    expect(settings).toContain("'Back up now'");
    expect(settings).toContain("api.post<{ file: string; bytes: number }>('backup')");
  });

  it('offers no agent config to copy, and names the command that writes it for every agent it knows', () => {
    expect(settings).not.toContain('Copy config');
    expect(settings).not.toContain('not available yet');
    expect(settings).toContain('<code>skeinwise connect claude-code</code>');
    for (const c of AGENT_CLIENTS) expect(settings).toContain(c.key);
  });

  it('says that entries leave this computer under the outside model', () => {
    const remote = settings.slice(settings.indexOf("ai.engine === 'remote' && ("), settings.indexOf("ai.engine === 'none' &&"));
    expect(remote).toContain('leave this computer');
  });
});
