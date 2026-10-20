// SPDX-License-Identifier: AGPL-3.0-only
//
// A separate process for the P1a lock proofs: a bare plan token lock holder
// that logs its hold interval to a shared file and holds for a time, or until
// the parent's release message. It answers on IPC only.

import { appendFileSync } from 'node:fs';
import { withTokenLock } from '../../../packages/core-custody/src/token-lock.ts';
import { sleep, type ChildCommand } from './plan-token-world.ts';

const command = JSON.parse(process.argv[2] ?? '{}') as Extract<ChildCommand, { op: 'hold' }>;
const send = (message: Record<string, unknown>): Promise<void> =>
  new Promise((resolve) => {
    process.send?.(message, () => resolve());
  });
const released = (): Promise<void> =>
  new Promise((resolve) => {
    process.once('message', () => resolve());
  });

const out = await withTokenLock(
  command.file,
  { deadlineAt: Date.now() + command.deadlineMs },
  async () => {
    appendFileSync(
      command.log,
      `enter ${command.id} ${performance.timeOrigin + performance.now()}\n`,
    );
    await send({ held: true });
    if (command.ms < 0) await released();
    else await sleep(command.ms);
    appendFileSync(
      command.log,
      `leave ${command.id} ${performance.timeOrigin + performance.now()}\n`,
    );
  },
);
await send(out.held ? { done: true } : { refused: out.why });

process.disconnect();
