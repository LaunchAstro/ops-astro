// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { reserveModelCall, sendReservedCall } from '../../packages/core-custody/src/index.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { caller, requestFor, stepOf } from './broker-world.ts';
import { callsOf, faultBroker, s, useFaultWorld, world } from './aw-10-world.ts';

useFaultWorld('sol_ow019');

it('one reserved call is dispatched once when its send is retried concurrently', async () => {
  const work = await liveWork(s, 'one hold and two sends', 2_000);
  await stepOf(work);
  const broker = faultBroker();
  const request = requestFor(work);
  const held = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), request, broker),
  );
  expect(held.ok).toBe(true);
  if (!held.ok) throw new Error(held.code);
  world.provider.mode('answer');
  const sent = world.provider.seen.length;
  await Promise.all([
    sendReservedCall(s.db.app, s.business, caller(work), request, held.reserved, broker),
    sendReservedCall(s.db.app, s.business, caller(work), request, held.reserved, broker),
  ]);
  expect(await callsOf(s, work)).toHaveLength(1);
  expect(world.provider.seen.length - sent).toBe(1);
});
