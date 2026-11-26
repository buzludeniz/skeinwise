// Settings shows no promise of a later version, no field that nothing reads, and says when entries leave this computer.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const settings = readFileSync(join(import.meta.dirname, '..', '..', 'web/src/ui/Settings.tsx'), 'utf8');

describe('Settings', () => {
  it('promises no later version', () => {
    expect(settings).not.toMatch(/comes in version|version 0\.\d/i);
  });

  it('has no Sync group, since nothing reads its folder', () => {
    expect(settings).not.toMatch(/'Sync'|title="Sync"|config\.sync\b|saveConfig\(\{ sync/);
  });

  it('offers no agent config to copy while agents cannot connect', () => {
    expect(settings).not.toContain('Copy config');
    expect(settings).toContain('Connecting an agent is not available yet.');
  });

  it('says that entries leave this computer under the outside model', () => {
    const remote = settings.slice(settings.indexOf("ai.engine === 'remote' && ("), settings.indexOf("ai.engine === 'none' &&"));
    expect(remote).toContain('leave this computer');
  });
});
