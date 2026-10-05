// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { startLiveTopics } from '../../apps/api/live.ts';
import { createStatementLog } from '../../packages/core-records/src/tenancy/statements.ts';

const noop = (): void => {};

it('overlapping shutdowns both wait for a stream admitted during closure', async () => {
  const topics = await startLiveTopics({
    log: createStatementLog(),
    listen: (_channel, _payload, ready) => {
      ready();
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
  let releaseFirst = noop;
  let releaseLate = noop;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const late = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  let offFirst = noop;
  let offLate = noop;
  offFirst = topics.subscribe(
    'business',
    'first',
    () => {},
    async () => {
      await first;
      offFirst();
    },
  );
  const closeA = topics.close();
  const closeB = topics.close();
  offLate = topics.subscribe(
    'business',
    'late',
    () => {},
    async () => {
      await late;
      offLate();
    },
  );
  releaseFirst();
  const observed = await Promise.race([closeA.then(() => 'closed'), setTimeout(50, 'waiting')]);
  releaseLate();
  await Promise.all([closeA, closeB]);
  expect(
    observed,
    'neither shutdown may close the database while the late stream is still stopping',
  ).toBe('waiting');
});
