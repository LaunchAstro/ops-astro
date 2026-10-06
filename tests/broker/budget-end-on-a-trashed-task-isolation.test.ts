// SPDX-License-Identifier: AGPL-3.0-only
//
// The end reaches a trashed task, so the crossings must hold there too. With
// the task in the trash, `run.end_at_budget_stop` through the command entry is
// refused to a person of this business without `gate:decide` on it; to a
// second business's decider naming this run under their own task or this one;
// to a person naming another task they hold; and to a person who holds it on
// another client's task of this business, naming this client's run under that
// task (the run-to-task guard answers, as for a made-up run) or this one (no
// authority on it). No refusal names this run, its task, ask, title or amount,
// and neither client's money moves.

import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { checkAuthority, statusOf } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  asPerson,
  createTask,
  liveWork,
  revisionOf,
  seedSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { noDatabase, s, useBrokerWorld } from './broker-world.ts';
import {
  moneyOf,
  one,
  people,
  stopped,
  UNDER_ONE_CALL,
  usePeople,
} from './budget-answers-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('endtrashiso');
usePeople();
beforeAll(async () => {
  if (noDatabase) return;
  // The decider makes the clients.
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'write', undefined, false, 'record');
  });
});

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

/**
 * A new client of this business, and `taskId` linked to it as `task.set_party` stores it.
 * The link is written directly: a task with work refuses a client change (S0-5) and a
 * client's task makes no model call (C60), so no command reaches a client's stopped run.
 */
async function underNewClient(taskId: string): Promise<string> {
  const made = appliedDetail(
    await asPerson(s, { command: 'client.create', operationId: randomUUID(), name: randomUUID() }),
    'client.create',
  );
  const client = String(made['clientId']);
  await s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
    [taskId, client],
  );
  return client;
}

/** The task's client, as the record's spine holds it. */
const clientOf = async (taskId: string): Promise<string | null> =>
  (
    await one<{ client: string | null }>(
      'select uuid_7::text as client from public.records where id = $1',
      [taskId],
    )
  ).client;

/** A run under client B stopped at its ceiling, its task then trashed. */
async function stoppedThenTrashed(): Promise<Named> {
  const target = await stopped(TITLE);
  await underNewClient(target.work.taskId);
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

/** A made-up run and ask under `taskId`. */
const madeUp = (taskId: string): Named => ({ taskId, runId: randomUUID(), askId: randomUUID() });

/** Client A's own task with a live run, set up before any money is read. */
async function clientAWork(): Promise<{ readonly theirs: Work; readonly clientA: string }> {
  const theirs = await liveWork(s, 'client A own work', 2_000);
  return { theirs, clientA: await underNewClient(theirs.taskId) };
}

/**
 * Client A's person, holding gate:decide on client A's own task, naming client B's run under
 * that task and under B's. The first passes authority, so only the run-to-task guard answers.
 */
async function fromAnotherClient(
  named: Named,
  { theirs, clientA }: Awaited<ReturnType<typeof clientAWork>>,
): Promise<readonly Ended[]> {
  const clientB = await clientOf(named.taskId);
  // A real crossing: two clients, both linked, not the same one.
  expect(clientB).not.toBeNull();
  expect(await clientOf(theirs.taskId)).toBe(clientA);
  expect(clientA).not.toBe(clientB);
  const { run_id: theirRun } = await one<{ run_id: string }>(
    `select run_id from public.leases where id = $1`,
    [theirs.picked['leaseId']],
  );
  const theirMoney = await moneyOf(theirRun);
  const bMoney = await moneyOf(named.runId);
  const onA = await enrol(s.db.app, s.business, 'on-client-a');
  const authorised = await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, onA, 'decide', { kind: 'party', id: clientA }, false, 'gate');
    return await checkAuthority(
      tx,
      [
        { kind: 'person', id: onA.personId },
        { kind: 'actor', id: onA.actorId },
      ],
      { collection: 'gate', action: 'decide', scope: { kind: 'record', id: theirs.taskId } },
    );
  });
  // The authorised side: the caller may decide on client A's own task.
  expect(authorised.ok).toBe(true);
  const underA = await endAs(onA, s.business, s.db, { ...named, taskId: theirs.taskId });
  const underB = await endAs(onA, s.business, s.db, named);
  const madeUpA = await endAs(onA, s.business, s.db, madeUp(theirs.taskId));
  const madeUpB = await endAs(onA, s.business, s.db, madeUp(named.taskId));
  expect(madeUpA.code, 'past authority on A, a made-up run is not found').toBe('NOT_FOUND');
  expect(underA.code).toBe('NOT_FOUND');
  expect(underA.bytes, 'the same bytes as a made-up run').toBe(madeUpA.bytes);
  expect(underB).toMatchObject({ code: 'SCOPE_NOT_GRANTED', status: 403 });
  expect(underB.bytes, 'the same bytes as a made-up run').toBe(madeUpB.bytes);
  expect(await moneyOf(theirRun), "client A's money").toStrictEqual(theirMoney);
  expect(await moneyOf(named.runId), "client B's money").toStrictEqual(bMoney);
  return [underA, underB];
}

it('ending a budget-stopped run on a trashed task is refused across every boundary', async () => {
  const named = await stoppedThenTrashed();
  const clientA = await clientAWork();
  const before = await moneyOf(named.runId);
  expect(before).toMatchObject({ run: 'waiting_budget', reservation: 'held' });

  // (a) This business, no gate:decide on the task (billing:decide only).
  const ungranted = await endAs(people.third, s.business, s.db, named);
  expect(ungranted).toMatchObject({ code: 'SCOPE_NOT_GRANTED', status: 403 });
  expect(await moneyOf(named.runId)).toStrictEqual(before);

  // (b) and (c): no refusal names this run, its task, ask, title or amount.
  const foreign = [named.taskId, named.runId, named.askId, TITLE, String(UNDER_ONE_CALL)];
  const crossings = [
    ...(await fromAnotherBusiness(named)),
    await fromAnotherTask(named),
    ...(await fromAnotherClient(named, clientA)),
  ];
  for (const answer of crossings) {
    expect(foreign.filter((value) => answer.bytes.includes(value))).toEqual([]);
  }
  expect(await moneyOf(named.runId)).toStrictEqual(before);
});
