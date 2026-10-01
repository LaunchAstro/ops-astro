// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-2 heartbeats, paced, through the worker process itself (review 86f3ae0,
// finding 3): six answered passes inside one gap send one ping, so the worker's
// loop is proven to use the paced beat, not only to read the setting.

import { expect, it, vi } from 'vitest';

let passes = 0;
vi.mock('../../apps/worker/worker.ts', () => ({
  createWorker: () => ({
    proposeOnce: () =>
      Promise.resolve(++passes < 5 ? { idle: { taskId: 't' } } : { proposed: { taskId: 't' } }),
    applyOnce: () => Promise.resolve({ applied: { taskId: 't' } }),
  }),
}));

it('the worker pings once per gap, not once per answered pass', async () => {
  const { main } = await import('../../apps/worker/main.ts');
  const beats: string[] = [];
  const code = await main(
    [],
    {
      OPS_ASTRO_BUSINESS: 'alpha',
      OPS_ASTRO_TOKEN: 'made-up-token',
      OPS_ASTRO_DELEGATION: 'made-up-delegation',
      OPS_ASTRO_WORKER_INTERVAL_MS: '0',
      OPS_HEARTBEAT_EVERY_MS: '1800000',
    },
    (address) => {
      beats.push(address ?? '');
      return Promise.resolve('sent');
    },
  );
  expect(code).toBe(0);
  expect(beats).toHaveLength(1);
});
