// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b, the delivery worker stopped: `stop` resolves only once the pass
// already running ends, and nothing starts after it, neither a new pass nor
// the next business of the running one. The server stops custody and closes
// the pool after `stop`, so a send in flight is never cut off by its own
// shutdown and left unknown. No database: a stand-in pool holds the pass.

import { expect, it } from 'vitest';
import { startMailWorker, type EmailTiming } from '../../packages/core-custody/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';

const delay = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Two businesses for the worker to serve, in order. */
const targets = async (): Promise<{ businessId: string; workerActorId: string }[]> =>
  await Promise.resolve([
    { businessId: 'first', workerActorId: 'worker' },
    { businessId: 'second', workerActorId: 'worker' },
  ]);

/** A promise the test resolves by hand. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

it('AW-07b delivery worker: stop waits for the pass already running and starts nothing after it', async () => {
  const pass = barrier();
  const entered: string[] = [];
  // Each business's pass opens one transaction; every one is held until released.
  const database = {
    withBusiness: async (businessId: string) => {
      entered.push(businessId);
      await pass.held;
    },
  } as unknown as Database;
  const worker = startMailWorker(database, targets, {} as EmailTiming, {
    atOnceMs: 10,
    dailyTickMs: 60_000,
  });
  await expect.poll(() => entered, { timeout: 2_000 }).toEqual(['first']);

  let stopped = false;
  // Read as a promise whatever `stop` returns, so a stop that waits for nothing shows as one.
  const stopping = (async () => {
    await Promise.resolve(worker.stop());
    stopped = true;
  })();
  await delay(50);
  expect(stopped).toBe(false);

  pass.release();
  await stopping;
  expect(stopped).toBe(true);
  await delay(50);
  expect(entered).toEqual(['first']);
});
