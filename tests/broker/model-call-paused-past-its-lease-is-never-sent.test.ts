// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's model call is marked started under its lease, then sent through
// custody. A call that waits between the two (in this process, on the way to
// custody, or in custody's own queue) past the lease's end would go out after
// the sweep counted it dropped and another pickup may hold the task. Custody is
// told when the lease ends, so such a call is never sent and its hold is
// released; one sent inside its lease is answered as before.

import { expect, it as vitestIt } from 'vitest';
import { liveWork } from '../runtime/schedules-harness.ts';
import { call, gated, noDatabase, s, useBrokerWorld, world } from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('pastlease');

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

it('a model call that waits past its lease before custody sends it reaches no provider and is released', async () => {
  const work = await liveWork(s, 'a call that waits past its lease', 2_000);
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() + interval '7 seconds' where id = $1`,
    [work.picked['leaseId']],
  );
  world.provider.mode('answer');
  const before = world.provider.seen.length;
  const held = gated();
  const calling = call(work, {}, held.broker);
  // The call is started under its lease and waits at custody's door until past its end.
  await sleep(8_000);
  held.open();
  const result = await calling;
  expect({ result, sent: world.provider.seen.length - before }).toMatchObject({
    result: { ok: false, code: 'CALL_RELEASED' },
    sent: 0,
  });
}, 30_000);

it('a model call sent well inside its lease is answered', async () => {
  const work = await liveWork(s, 'a call inside its lease', 2_000);
  world.provider.mode('answer');
  expect(await call(work)).toMatchObject({ ok: true });
});
