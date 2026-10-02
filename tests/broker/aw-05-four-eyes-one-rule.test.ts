// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's top-up at the budget stop pairs its approvers by the core's one
// four-eyes rule (`core-runtime/src/four-eyes.ts`), the rule T2e's top-up and
// T3c's write-off already use, not a second copy of it:
// - above the band, a first approval pairs only when the person who gave it
//   still holds `billing:decide` on the task at the locked instant;
// - a business with no stored band has the shipped 500, as T2e's top-up does.
// AW-05's own cases (`aw-05-budget-top-up.test.ts`) run unchanged beside these.

import { expect, it as vitestIt } from 'vitest';
import {
  topUpAtBudgetStop,
  type BudgetAnswerRequest,
} from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { as, moneyOf, people, setThreshold, stopped, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw05foureyes');
usePeople();

const topUp = async (request: BudgetAnswerRequest, amountMinor: number) =>
  await s.db.app.withBusiness(
    s.business,
    async (tx) => await topUpAtBudgetStop(tx, { ...request, amountMinor, currency: 'AUD' }),
  );

it('AW-05 four eyes is the one rule: a first approver whose grant has lapsed does not pair', async () => {
  // One dollar: 100 minor units of AUD, so 300 needs two people.
  await setThreshold(1);
  const { runId } = await stopped('aw05 one rule lapsed first');
  const gone = await enrol(s.db.app, s.business, 'first-then-gone');
  const grantId = await s.db.app.withBusiness(
    s.business,
    async (tx) => await grantTo(tx, gone, 'decide', undefined, false, 'billing'),
  );
  const first = await topUp(as(gone, runId), 300);
  expect(first).toMatchObject({ ok: true, value: { state: 'awaiting_second' } });
  const before = await moneyOf(runId);

  // The first approver's grant ends before anyone pairs with it.
  await s.db.admin.execute(`update public.grants set expires_at = now() where id = $1`, [grantId]);

  // The plan approver's approval is a first approval of its own, not a pair:
  // nothing is raised, the run still waits, and one more approval is recorded.
  const second = await topUp(as(people.approver, runId), 300);
  expect(second).toMatchObject({ ok: true, value: { state: 'awaiting_second' } });
  expect(await moneyOf(runId)).toEqual({ ...before, approvals: before.approvals + 1 });

  // A live holder then pairs with the plan approver and the top-up applies.
  const third = await topUp(as(people.second, runId), 300);
  expect(third).toMatchObject({ ok: true, value: { state: 'applied' } });
  expect(await moneyOf(runId)).toMatchObject({ run: 'planned', answers: 1 });
});

it('AW-05 four eyes is the one rule: a business with no stored band has the shipped 500', async () => {
  await s.db.admin.execute(
    `delete from public.business_settings where business_id = $1 and key = 'four_eyes_threshold'`,
    [s.business],
  );
  const { runId } = await stopped('aw05 one rule no band');

  // 300 minor units is 3.00 AUD, under the shipped 500.00: one person applies it.
  const answer = await topUp(as(people.approver, runId), 300);
  expect(answer).toMatchObject({ ok: true, value: { state: 'applied' } });
  expect(await moneyOf(runId)).toMatchObject({ run: 'planned', answers: 1, approvals: 1 });
});
