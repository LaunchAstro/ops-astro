// SPDX-License-Identifier: AGPL-3.0-only
//
// A top-up at the budget stop raises the run's hold and its envelope in exact
// minor units. Each figure is a whole number of minor units the database keeps
// as `bigint`, and a hold plus a valid top-up can pass 2^53, where a
// JavaScript number no longer holds every integer. The raised hold is summed
// in exact integers, so it lands on the unit a person approved.

import { expect, it as vitestIt } from 'vitest';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import {
  as,
  moneyOf,
  people,
  setThreshold,
  stopped,
  UNDER_ONE_CALL,
  usePeople,
} from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('exacttopup');
usePeople();

it('a top-up whose raised hold passes 2^53 keeps the reservation and the envelope exact', async () => {
  await setThreshold(null);
  const { runId } = await stopped('top-up past safe integers');
  // A cap with room for the largest top-up a JavaScript number can carry exactly.
  await s.db.admin.execute(`update public.budget_caps set limit_minor = $2 where id = $1`, [
    s.capId,
    (2n ** 62n).toString(),
  ]);
  const before = await moneyOf(runId);
  const amount = Number.MAX_SAFE_INTEGER;

  const answered = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, {
        ...as(people.approver, runId),
        amountMinor: amount,
        currency: 'AUD',
      }),
  );
  expect(answered).toMatchObject({ ok: true, value: { state: 'applied' } });

  const plus = (figure: string): string => (BigInt(figure) + BigInt(amount)).toString();
  expect(await moneyOf(runId)).toMatchObject({
    run: 'planned',
    reservation: 'held',
    held: plus(String(UNDER_ONE_CALL)),
    maximum: plus(before.maximum),
    envelope_held: plus(before.envelope_held),
    envelope_actual: before.envelope_actual,
    cap_committed: plus(before.cap_committed),
  });
});
