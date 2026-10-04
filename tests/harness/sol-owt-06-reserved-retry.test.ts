// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { reserveModelCall, sendReservedCall } from '../../packages/core-custody/src/index.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import {
  broker,
  caller,
  requestFor,
  rowsOf,
  s,
  stepOf,
  useBrokerWorld,
  world,
} from '../broker/broker-world.ts';

useBrokerWorld('solowt06');

it('Sol proof, criterion 5: retrying a reserved model call sends it only once', async () => {
  world.provider.mode('answer');
  const work = await liveWork(s, 'Sol reserved retry', 2_000);
  await stepOf(work);
  const reservation = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, caller(work), requestFor(work), broker),
  );
  if (!reservation.ok) throw new Error(`reserve refused ${reservation.code}`);
  const before = world.provider.seen.length;
  const send = async () =>
    await sendReservedCall(
      s.db.app,
      s.business,
      caller(work),
      requestFor(work),
      reservation.reserved,
      broker,
    );
  expect(await send()).toMatchObject({ ok: true });
  expect(await rowsOf(reservation.reserved.callId)).toMatchObject([{ state: 'settled' }]);
  expect(world.provider.seen.length - before).toBe(1);
  await send();
  expect(world.provider.seen.length - before).toBe(1);
});
