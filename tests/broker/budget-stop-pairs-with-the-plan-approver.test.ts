// SPDX-License-Identifier: AGPL-3.0-only
//
// Above the four-eyes band a top-up at the budget stop needs two people, and
// while the plan approver holds billing:decide one of the two is the plan
// approver. A first approval by someone else must not stand in the way: when
// the plan approver's approval is waiting, a third holder pairs with it, even
// though an earlier approval by another live holder is also waiting.

import { expect, it as vitestIt } from 'vitest';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import {
  as,
  moneyOf,
  one,
  people,
  setThreshold,
  stopped,
  usePeople,
} from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('pairplanapprover');
usePeople();

const AMOUNT = 300;

const approve = async (member: Member, runId: string) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, { ...as(member, runId), amountMinor: AMOUNT, currency: 'AUD' }),
  );

const billingGrant = async (member: Member): Promise<string> =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) => await grantTo(tx, member, 'decide', undefined, false, 'billing'),
  );

it('the top-up applies with the plan approver and a third holder while an earlier approval waits', async () => {
  // A band of 1 AUD: the top-up is above it and needs two people.
  await setThreshold(1);
  const a = await enrol(s.db.app, s.business, 'early-approver');
  const c = await enrol(s.db.app, s.business, 'third-approver');
  const aGrant = await billingGrant(a);
  await billingGrant(c);
  const { runId } = await stopped('pair with the plan approver');
  const before = await moneyOf(runId);

  // A, who did not approve the plan, approves first; then A's grant ends.
  expect(await approve(a, runId)).toMatchObject({ ok: true, value: { state: 'awaiting_second' } });
  await s.db.app.withBusiness(s.business, async (tx) => {
    await tx.query(
      'update public.grants set revoked_at = now() where business_id = $1 and id = $2',
      [tx.businessId, aGrant],
    );
  });

  // B, the plan approver, approves the same amount while A cannot pair.
  expect(await approve(people.approver, runId)).toMatchObject({
    ok: true,
    value: { state: 'awaiting_second' },
  });

  // A's authority is restored, and C approves: B and C are the two.
  await billingGrant(a);
  expect(await approve(c, runId)).toMatchObject({ ok: true, value: { state: 'applied' } });
  const answer = await one<{ first: string; second: string }>(
    `select first_person_id as first, second_person_id as second
       from public.budget_answers where run_id = $1 and kind = 'top_up'`,
    [runId],
  );
  expect(answer).toEqual({ first: people.approver.personId, second: c.personId });
  expect(await moneyOf(runId)).toMatchObject({
    run: 'planned',
    maximum: String(Number(before.maximum) + AMOUNT),
    answers: 1,
    approvals: 3,
  });
});
