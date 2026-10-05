// SPDX-License-Identifier: AGPL-3.0-only
//
// The end reaches a trashed task, so the crossings must hold there too. With
// the task in the trash, `run.end_at_budget_stop` through the command entry is
// refused to a person of this business without `gate:decide` on it; to a
// second business's decider naming this run under their own task or this one;
// and to a person naming another task they hold, with the same bytes as a
// made-up run. No refusal names this run, its task, ask, title or amount, and
// nothing moves.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { statusOf } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asPerson,
  createTask,
  liveWork,
  revisionOf,
  seedSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import { moneyOf, people, stopped, UNDER_ONE_CALL, usePeople } from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('endtrashiso');
usePeople();

const TITLE = 'a trashed task the crossings aim at';

/** `run.end_at_budget_stop` through the command entry, as `member` of `business`. */
async function endAs(
  member: Member,
  business: Schedules['business'],
  database: Schedules['db'],
  named: Named,
) {
  const result = await executeCommand(database.app, business, member.presented, 'api', {
    command: 'run.end_at_budget_stop',
    operationId: randomUUID(),
    recordId: named.taskId,
    runId: named.runId,
    askId: named.askId,
  } as never);
  if (!isCommandRefusal(result)) return { code: 'applied', status: 200, bytes: '' };
  return { code: result.code, status: statusOf(result.code), bytes: JSON.stringify(result) };
}

interface Named {
  readonly taskId: string;
  readonly runId: string;
  readonly askId: string;
}

type Ended = Awaited<ReturnType<typeof endAs>>;

/** A run stopped at its ceiling, its task then trashed. */
async function stoppedThenTrashed(): Promise<Named> {
  const target = await stopped(TITLE);
  const trashed = await asPerson(s, {
    command: 'task.trash',
    operationId: randomUUID(),
    recordId: target.work.taskId,
    expectedRevision: await revisionOf(s, target.work.taskId),
  });
  appliedDetail(trashed, 'task.trash');
  return { taskId: target.work.taskId, runId: target.runId, askId: target.askId };
}

/** A second business: its own decider, grants and a task with a live run, naming this run. */
async function fromAnotherBusiness(named: Named): Promise<readonly Ended[]> {
  const bravo = await seedSchedules(s.db, 'endtrashiso-bravo', 1_000_000);
  await bravo.db.app.withBusiness(bravo.business, async (tx) => {
    await grantTo(tx, bravo.decider, 'decide', undefined, false, 'gate');
  });
  const theirs = await liveWork(bravo, 'bravo own work', 2_000);
  const ownTask = await endAs(bravo.decider, bravo.business, bravo.db, {
    ...named,
    taskId: theirs.taskId,
  });
  const thisTask = await endAs(bravo.decider, bravo.business, bravo.db, named);
  const madeUp = await endAs(bravo.decider, bravo.business, bravo.db, {
    taskId: theirs.taskId,
    runId: randomUUID(),
    askId: randomUUID(),
  });
  expect(ownTask.code).toBe('NOT_FOUND');
  expect(thisTask.code).toBe('NOT_FOUND');
  expect(ownTask.bytes, 'the same bytes as a made-up run').toBe(madeUp.bytes);
  return [ownTask, thisTask];
}

/** This business, a person holding gate:decide on another task only, naming this run. */
async function fromAnotherTask(named: Named): Promise<Ended> {
  const otherTask = await createTask(s, 'another task the caller holds');
  const narrow = await enrol(s.db.app, s.business, 'narrow');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, narrow, 'decide', { kind: 'record', id: otherTask }, false, 'gate');
  });
  const crossed = await endAs(narrow, s.business, s.db, { ...named, taskId: otherTask });
  const madeUp = await endAs(narrow, s.business, s.db, {
    taskId: otherTask,
    runId: randomUUID(),
    askId: randomUUID(),
  });
  expect(crossed.code).toBe('NOT_FOUND');
  expect(crossed.bytes, 'the same bytes as a made-up run').toBe(madeUp.bytes);
  return crossed;
}

it('ending a budget-stopped run on a trashed task is refused across every boundary', async () => {
  const named = await stoppedThenTrashed();
  const before = await moneyOf(named.runId);
  expect(before).toMatchObject({ run: 'waiting_budget', reservation: 'held' });

  // (a) This business, no gate:decide on the task (billing:decide only).
  const ungranted = await endAs(people.third, s.business, s.db, named);
  expect(ungranted).toMatchObject({ code: 'SCOPE_NOT_GRANTED', status: 403 });
  expect(await moneyOf(named.runId)).toStrictEqual(before);

  // (b) and (c): no refusal names this run, its task, ask, title or amount.
  const foreign = [named.taskId, named.runId, named.askId, TITLE, String(UNDER_ONE_CALL)];
  for (const answer of [...(await fromAnotherBusiness(named)), await fromAnotherTask(named)]) {
    expect(foreign.filter((value) => answer.bytes.includes(value))).toEqual([]);
  }
  expect(await moneyOf(named.runId)).toStrictEqual(before);
});
