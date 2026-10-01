// SPDX-License-Identifier: AGPL-3.0-only
//
// PLANFIX-3A settle, security finding M1: the deployment sweep holds a sent
// call on a lease that ended as unknown liability with its drop recorded, and
// an answer that arrives after it settled the row with the drop still on it,
// which `model_calls_drop_is_held` (0191) refuses: the settle threw and the
// call stayed held at its maximum. A late answer settles at its price.

import { expect, it as vitestIt } from 'vitest';
import { sweepDeployment } from '../../apps/api/recovery-entry.ts';
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

useBrokerWorld('pf3asecm1');

const resolve = async (key: string): Promise<string | undefined> =>
  await Promise.resolve(key === 'home' ? s.business : undefined);

it('M1: an answer after the sweep held the call settles it at its price', async () => {
  const work = await liveWork(s, 'pf3a sec m1', 2_000);
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
  expect(await sweepDeployment(s.db.app, resolve, ['home'])).toMatchObject({ ok: true });
  world.provider.mode('answer');
  const result = await pending;

  expect(result).toEqual({ ok: false, code: 'LEASE_EXPIRED', callId: expect.any(String) });
  expect(await rowsOf((result as { callId: string }).callId)).toMatchObject([
    { state: 'settled', actual_minor: '3', drop_state: null },
  ]);
});
