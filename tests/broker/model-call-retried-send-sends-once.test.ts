// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { reserveModelCall, sendReservedCall } from '../../packages/core-custody/src/index.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { broker, caller, requestFor, s, stepOf, useBrokerWorld, world } from './broker-world.ts';

useBrokerWorld('solow011retry');

it('retrying a committed model-call hold sends and charges once', async () => {
  const work = await liveWork(s, 'one committed model-call hold', 2_000);
  await stepOf(work);
  world.provider.mode('answer');
  const request = requestFor(work);
  const who = caller(work);
  const held = await s.db.app.withBusiness(
    s.business,
    async (tx) => await reserveModelCall(tx, who, request, broker),
  );
  if (!held.ok) throw new Error(`reserve refused ${held.code}`);
  const before = world.provider.seen.length;
  const first = await sendReservedCall(s.db.app, s.business, who, request, held.reserved, broker);
  expect(first).toMatchObject({ ok: true, actualMinor: 100 });
  expect(world.provider.seen.length - before).toBe(1);
  await sendReservedCall(s.db.app, s.business, who, request, held.reserved, broker);
  const ledger = await s.db.admin.execute(
    `select count(*)::int as calls, sum(actual_minor)::text as recorded_cost
       from public.model_calls where id = $1`,
    [held.reserved.callId],
  );
  expect({ sends: world.provider.seen.length - before, ledger }).toEqual({
    sends: 1,
    ledger: [{ calls: 1, recorded_cost: '100' }],
  });
});
