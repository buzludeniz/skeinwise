// The app's Record live switch (src/server/live.ts) turned off and straight back on: the new stream starts only once
// the old one's pass has ended, so two passes never run side by side over the record. startLive is a stand-in here;
// test/background.test.ts shows that a stream's stop() ends its pass and resolves after.

import { describe, expect, it, vi } from 'vitest';

const started: { stop: ReturnType<typeof vi.fn> }[] = [];
vi.mock('../../src/live/run.ts', () => ({
  startLive: vi.fn(() => {
    const run = { stop: vi.fn() };
    started.push(run);
    return run;
  }),
}));

const { AppLive } = await import('../../src/server/live.ts');
const { startLive } = await import('../../src/live/run.ts');
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('Record live, off and on again', () => {
  it('starts the new stream only after the old one has stopped', async () => {
    const live = new AppLive({} as never, '/nonexistent-home', { userHome: '/nonexistent-user' });
    live.set(true);
    await settle();
    expect(startLive).toHaveBeenCalledTimes(1);

    let ended!: () => void;
    started[0]!.stop.mockReturnValue(new Promise<void>((r) => (ended = r)));
    live.set(false);
    live.set(true);
    live.set(true);
    await settle();
    expect(started[0]!.stop).toHaveBeenCalledTimes(1);
    expect(startLive).toHaveBeenCalledTimes(1);

    ended();
    await settle();
    expect(startLive).toHaveBeenCalledTimes(2);

    // Off again before the old pass ended: nothing starts when it does.
    let endedAgain!: () => void;
    started[1]!.stop.mockReturnValue(new Promise<void>((r) => (endedAgain = r)));
    live.set(false);
    live.set(true);
    live.set(false);
    endedAgain();
    await settle();
    expect(startLive).toHaveBeenCalledTimes(2);
  });
});
