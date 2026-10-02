// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-BATCH-2 batch 3a, finding 6 (weak test): aw-01-broker-limits.test.ts's
// "expired lease: the cost settles and the work is refused" asserts only
// `{ ok: false }`, so a settle that held the call as an unknown liability, or
// refused it for any other reason, would pass it. This is the stronger form:
// the refusal is LEASE_EXPIRED by name, and the call's row is settled at the
// price the provider reported (slow mode answers usage 1/1, so 1 + 2 * 1 = 3).

import { expect, it as vitestIt } from 'vitest';
import { catalogue, REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { callModel } from '../../packages/core-custody/src/index.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import {
  broker,
  caller,
  noDatabase,
  requestFor,
  rowsOf,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from './broker-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('rv3a6');

it('REVIEW-3A-6: a lease expiring mid-call is refused LEASE_EXPIRED and the call settles at its price of 3', async () => {
  const work = await liveWork(s, 'rv3a6 expires mid-call', 2_000);
  await stepOf(work);
  world.provider.mode('slow');
  const seen = world.provider.seen.length;
  const pending = callModel(s.db.app, s.business, caller(work), requestFor(work), {
    ...broker,
    operations: catalogue([{ ...REPLAY_COMPOSE, timeoutMs: 20_000 }]),
  });
  await expect.poll(() => world.provider.seen.length, { timeout: 5_000 }).toBe(seen + 1);
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() where id = $1`,
    [work.picked['leaseId']],
  );
  world.provider.mode('answer');
  const result = await pending;

  expect(result).toEqual({
    ok: false,
    code: 'LEASE_EXPIRED',
    callId: expect.any(String),
  });
  const [row] = await rowsOf((result as { callId: string }).callId);
  expect(row?.['state']).toBe('settled');
  expect(Number(row?.['actual_minor'])).toBe(3);
  expect(Number(row?.['observed_minor'])).toBe(3);
  expect(row?.['ended_at']).not.toBeNull();
});
