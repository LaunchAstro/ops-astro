// SPDX-License-Identifier: AGPL-3.0-only
//
// Both top-ups read the task live before they lock it. A trash that commits
// between that read and the locks leaves the run, lineage and envelope as they
// were, so each top-up must read the task again under the task lock it takes.
// Each is paused on a backend of its own after its unlocked read, the task is
// trashed on another, and on resume each answers NOT_FOUND with nothing moved.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import { topUp, topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { appliedDetail, asPerson, racer, revisionOf } from '../runtime/schedules-harness.ts';
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

useBrokerWorld('topuptrash');
usePeople();

type Paused = (tx: TenantQuery) => Promise<{ readonly ok: boolean; readonly refusal?: unknown }>;

/**
 * Run `answer` on a backend of its own, paused once the first statement
 * `matches` names has returned, until the task is trashed on another backend.
 * What it answered, and the money as it stood once the trash committed.
 */
async function racedByTrash(
  taskId: string,
  runId: string,
  matches: (sql: string) => boolean,
  answer: Paused,
) {
  const own = racer(s);
  let reach!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let paused = false;
  const pending = own.withBusiness(s.business, async (tx) => {
    const held: TenantQuery = {
      ...tx,
      query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
        const found = await tx.query<Row>(sql, parameters);
        if (!paused && matches(sql)) {
          paused = true;
          reach();
          await gate;
        }
        return found;
      },
    };
    return await answer(held);
  });
  try {
    await reached;
    const trashed = await asPerson(s, {
      command: 'task.trash',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(s, taskId),
    });
    appliedDetail(trashed, 'task.trash');
    const atTrash = await moneyOf(runId);
    resume();
    return { outcome: await pending, atTrash };
  } finally {
    resume();
    await pending.catch(() => null);
    await own.close();
  }
}

it('a top-up at the budget stop paused before its locks refuses a task trashed meanwhile', async () => {
  await setThreshold(500);
  const { work, runId } = await stopped('top-up at the stop, trashed mid-answer');
  const { outcome, atTrash } = await racedByTrash(
    work.taskId,
    runId,
    (sql) => sql.includes('from public.planned_runs run') && sql.includes('k.reservation_id'),
    async (tx) =>
      await topUpAtBudgetStop(tx, {
        ...as(people.approver, runId),
        amountMinor: 300,
        currency: 'AUD',
      }),
  );
  expect(outcome).toMatchObject({ ok: false, refusal: { code: 'NOT_FOUND' } });
  expect(atTrash).toMatchObject({ run: 'waiting_budget', reservation: 'held', answers: 0 });
  expect(await moneyOf(runId), 'no approval, answer, hold, run or envelope moved').toEqual(atTrash);
});

it('an ordinary top-up paused before its locks refuses a task trashed meanwhile', async () => {
  await setThreshold(500);
  const { work, runId } = await stopped('ordinary top-up, trashed mid-answer');
  const { maximum } = await one<{ maximum: string }>(
    `select maximum_minor::text as maximum from public.task_envelopes where task_id = $1`,
    [work.taskId],
  );
  const { outcome, atTrash } = await racedByTrash(
    work.taskId,
    runId,
    (sql) => sql.includes('task_envelopes'),
    async (tx) =>
      await topUp(tx, {
        taskId: work.taskId,
        amountMinor: 300n,
        fromMaximumMinor: BigInt(maximum),
        personId: people.approver.personId,
        subjects: as(people.approver, runId).subjects,
        collection: 'billing',
      }),
  );
  expect(outcome).toMatchObject({ ok: false, refusal: { code: 'NOT_FOUND' } });
  expect(await moneyOf(runId), 'the envelope keeps its maximum').toEqual(atTrash);
});
