// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import { s, useBrokerWorld } from '../broker/broker-world.ts';
import { moneyOf, people, stopped, usePeople } from '../broker/budget-answers-world.ts';
import { asPerson, topUpBody, useAnswerRoutes } from '../broker/budget-answer-routes-world.ts';

useBrokerWorld('solow049band');
usePeople();
useAnswerRoutes('solow049band');

it('a budget-stop top-up above a valid fractional threshold cannot apply with one approver', async () => {
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'decide', undefined, false, 'spend');
  });
  const setting = await asPerson(people.approver, '/settings/set_four_eyes_threshold', {
    operationId: crypto.randomUUID(),
    value: 500.005,
  });
  expect(setting.status, 'the real settings command accepts the fractional threshold').toBe(200);
  const { work, runId, askId } = await stopped('Sol threshold proof');
  const before = await moneyOf(runId);
  // 50 001 minor units is AUD 500.01, strictly above the accepted AUD 500.005.
  const answer = await asPerson(people.approver, '/run/top_up', {
    ...topUpBody(work.taskId, runId, askId),
    amountMinor: 50_001,
  });
  expect(answer.status, 'the authenticated budget answer is accepted').toBe(200);
  expect
    .soft(answer.body['detail'], 'above the stored threshold requires a second person')
    .toMatchObject({ state: 'awaiting_second' });
  expect
    .soft(await moneyOf(runId), 'a first approval must not raise or resume the stopped run')
    .toEqual({ ...before, approvals: before.approvals + 1 });
});
