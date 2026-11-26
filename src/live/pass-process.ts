// The child process behind Background's isolated passes (src/live/organise.ts): opens the record on a connection of
// its own, organises what is new, and sends back what it did. When it exits, the memory the pass used goes with it.

import { organiseNew, type PassReply } from './organise.ts';
import { openHome } from '../home.ts';

const send = process.send?.bind(process);
if (!send) throw new Error('pass-process.ts runs only as a child process with an IPC channel (see Background)');
const reply = (r: PassReply) => new Promise<void>((done) => send(r, undefined, {}, () => done()));

// Live closed or killed: stop here. Live stops a pass by ending this process (Background.stop); the run cut off is
// marked failed there, and saved nothing, as a run saves in one transaction at its end.
process.on('disconnect', () => process.exit(0));

let started = false;
process.on('message', (message: { type?: string; home?: string }) => {
  if (message?.type === 'start' && message.home && !started) {
    started = true;
    void pass(message.home);
  }
});

async function pass(home: string): Promise<void> {
  let outcome: PassReply;
  const store = openHome(home);
  try {
    const result = await organiseNew(store, home, { fetch, env: process.env, progress: (line) => void reply({ type: 'progress', line }), stopped: () => false });
    outcome = { type: 'done', result };
  } catch (error) {
    outcome = { type: 'error', message: error instanceof Error ? error.message : String(error) };
  } finally {
    store.db.close();
  }
  await reply(outcome);
  process.disconnect?.();
}
