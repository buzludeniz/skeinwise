// A stand-in for src/live/pass-process.ts (test/background.test.ts, Background's `passScript`): it writes its pid to
// FAKE_PASS_PID, then on start sends the messages in FAKE_PASS_REPLIES (JSON), FAKE_PASS_GAP_MS apart. With
// FAKE_PASS_EXIT it exits after the last one; otherwise it stays until it is ended, as a hung pass would.

import { writeFileSync } from 'node:fs';

writeFileSync(process.env.FAKE_PASS_PID, String(process.pid));
const keepAlive = setInterval(() => {}, 60_000);
process.on('message', async (message) => {
  if (message?.type !== 'start') return;
  for (const reply of JSON.parse(process.env.FAKE_PASS_REPLIES ?? '[]')) {
    await new Promise((r) => setTimeout(r, Number(process.env.FAKE_PASS_GAP_MS ?? 0)));
    await new Promise((r) => process.send(reply, undefined, {}, r));
  }
  if (process.env.FAKE_PASS_EXIT) {
    clearInterval(keepAlive);
    process.disconnect();
  }
});
