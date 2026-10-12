// SPDX-License-Identifier: AGPL-3.0-only
//
// A top-up carries a whole amount and, at a budget stop, the envelope's
// currency. One with either null or absent is no answer: the run stopped at
// its ceiling keeps waiting and nothing moves. The task top-up's first
// approval is read back by its amount, so one recorded with none pairs with
// no second approver.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import type { Member } from '../commands/fixture.ts';
import { codeOf } from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, one, people, setThreshold, stopped, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('noamount');
usePeople();

const command = async (who: Member, body: Readonly<Record<string, unknown>>) =>
  await executeCommand(s.db.app, s.business, who.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);

const maximumOf = async (taskId: string): Promise<string> =>
  (
    await one<{ maximum: string }>(
      `select maximum_minor::text as maximum from public.task_envelopes
        where task_id = $1 and state = 'open'`,
      [taskId],
    )
  ).maximum;

it('a stop top-up with a null or absent amount or currency is refused and the run keeps waiting', async () => {
  await setThreshold(null);
  const { work, runId, askId } = await stopped('top-up with no amount');
  const before = await moneyOf(runId);
  expect(before).toMatchObject({ run: 'waiting_budget', answers: 0 });
  const named = { command: 'run.top_up', recordId: work.taskId, runId, askId };

  for (const figures of [
    { amountMinor: null, currency: 'AUD' },
    { currency: 'AUD' },
    { amountMinor: 300, currency: null },
    { amountMinor: 300 },
    {},
  ]) {
    // eslint-disable-next-line no-await-in-loop
    expect(codeOf(await command(people.approver, { ...named, ...figures }))).toBe(
      'FIELD_VALUE_INVALID',
    );
    // eslint-disable-next-line no-await-in-loop
    expect(await moneyOf(runId)).toEqual(before);
  }

  // The same stop still takes a whole answer.
  const whole = await command(people.approver, { ...named, amountMinor: 300, currency: 'AUD' });
  expect(codeOf(whole)).toBe('applied');
  expect(await moneyOf(runId)).toMatchObject({ run: 'planned', answers: 1 });
});

it('a task top-up with a null or absent amount is refused and the envelope stays', async () => {
  await setThreshold(null);
  const { work } = await stopped('task top-up with no amount');
  const maximum = await maximumOf(work.taskId);
  const named = { command: 'budget.top_up', recordId: work.taskId };

  for (const figures of [
    { amountMinor: null, fromMaximumMinor: Number(maximum) },
    { fromMaximumMinor: Number(maximum) },
    { amountMinor: 300, fromMaximumMinor: null },
    { amountMinor: 300 },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    expect(codeOf(await command(people.approver, { ...named, ...figures }))).toBe(
      'FIELD_VALUE_INVALID',
    );
    // eslint-disable-next-line no-await-in-loop
    expect(await maximumOf(work.taskId)).toBe(maximum);
  }
});

it('a first approval recorded with no amount pairs with no second approver', async () => {
  // One dollar: a 300 top-up needs two people.
  await setThreshold(1);
  const { work } = await stopped('first approval with no amount');
  const maximum = await maximumOf(work.taskId);
  const topUp = (who: Member, amountMinor: number) =>
    command(who, {
      command: 'budget.top_up',
      recordId: work.taskId,
      amountMinor,
      fromMaximumMinor: Number(maximum),
    });
  // A real first approval of another figure, and its copy in the register with the amount null.
  expect(codeOf(await topUp(people.approver, 301))).toBe('applied');
  await s.db.admin.execute(
    `insert into public.operations
       (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result,
        record_id, revision)
     select business_id, gen_random_uuid(), $2, command, actor_id, payload_digest, outcome,
            jsonb_set(result, '{detail,amountMinor}', 'null'), record_id, revision
       from public.operations
      where command = 'budget.top_up' and record_id = $1`,
    [work.taskId, randomUUID()],
  );

  // Unpaired, the second holder's 300 is a first approval the plan approver must give.
  expect(codeOf(await topUp(people.second, 300))).toBe('SCOPE_NOT_GRANTED');
  expect(await maximumOf(work.taskId)).toBe(maximum);

  // A first approval of 300 with its amount pairs, and the envelope moves.
  expect(codeOf(await topUp(people.approver, 300))).toBe('applied');
  expect(await topUp(people.second, 300)).toMatchObject({ detail: { state: 'applied' } });
  expect(await maximumOf(work.taskId)).toBe(String(Number(maximum) + 300));
});
