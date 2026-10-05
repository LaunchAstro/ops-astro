// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's own lease stopped at its ceiling after its effect applied, the
// shared half: the work, its calls, the stop, an observation that keeps the
// hold whole, and the rows an answer moves, read so a refusal can be shown to
// have written nothing. Each file opens its own world (`useBrokerWorld`).

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { executeCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import type { CommandRefusal } from '../../packages/core-records/src/index.ts';
import { callModel } from '../../packages/core-custody/src/index.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import {
  appliedDetail,
  approve,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  proposeBody,
  revisionOf,
  type Detail,
} from '../runtime/schedules-harness.ts';
import { PRICED } from '../runtime/t2d-harness.ts';
import { seedLaunch } from '../runtime/launch-seed.ts';
import { broker, requestFor, s, stepOf, world } from './broker-world.ts';
import { moneyOf, one, type Money } from './budget-answers-world.ts';
import type { Member } from '../commands/fixture.ts';

/** The replay operation's priced maximum: one call fits, and the next stops. */
export const ONE_CALL = 500;

/** The decider's own synthetic work, picked up and launched. */
export interface PersonWork {
  readonly taskId: string;
  readonly picked: Detail;
  readonly attemptId: string;
}

/** The work's lease and fence, as a command names them. */
export interface Lease {
  readonly leaseId: unknown;
  readonly fence: unknown;
}

/** The decider's own synthetic work on a hold of one call, picked up and launched. */
async function personWork(): Promise<PersonWork> {
  const taskId = await createTask(s, `end observed ${freshPurpose()}`);
  const body = {
    ...proposeBody(taskId, await revisionOf(s, taskId), {
      purpose: freshPurpose(),
      maximumMinor: ONE_CALL,
    }),
    step: { kind: 'synthetic_comment', payload: {} },
  };
  const decision = await approve(s, appliedDetail(await asPerson(s, body), 'task.propose'));
  const picked = appliedDetail(
    await asPerson(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: decision['reservationId'],
    }),
    'task.pickup',
  );
  await seedLaunch(s, picked);
  return { taskId, picked, attemptId: String(picked['attemptId']) };
}

/** A call under the person's own lease: no delegation, the person attending. */
const personCall = async (w: { taskId: string; picked: Detail }) => {
  const work = { taskId: w.taskId, picked: w.picked, proposal: {}, decision: {} };
  await stepOf(work);
  return await callModel(
    s.db.app,
    s.business,
    { actorId: s.decider.actorId, delegationId: null, attendedByPersonId: s.decider.personId },
    requestFor(work),
    broker,
  );
};

/** The run, its hold and envelope (`moneyOf`), with the attempt's state. */
export const stateOf = async (
  runId: string,
  attemptId: string,
): Promise<Money & { attempt: string }> => ({
  ...(await moneyOf(runId)),
  ...(await one<{ attempt: string }>(`select state as attempt from public.attempts where id = $1`, [
    attemptId,
  ])),
});

/** The effect applied and one call settled: the next call stops the run at its ceiling. */
export async function appliedWithOneCall(): Promise<{ w: PersonWork; lease: Lease }> {
  const w = await personWork();
  const lease = { leaseId: w.picked['leaseId'], fence: w.picked['fence'] };
  appliedDetail(
    await asPerson(s, { command: 'task.dispatch', operationId: randomUUID(), ...lease }),
    'task.dispatch',
  );
  appliedDetail(
    await asPerson(s, {
      command: 'task.comment',
      operationId: effectOperationId(w.attemptId),
      recordId: w.taskId,
      expectedRevision: await revisionOf(s, w.taskId),
      body: 'The synthetic change, applied once. Nothing left the app.',
      audience: 'internal',
    }),
    'task.comment',
  );
  world.provider.mode('answer');
  expect((await personCall(w)).ok).toBe(true);
  return { w, lease };
}

/** The next call stops the run at its ceiling and raises the ask, committed on its own connection. */
export async function stopIt(
  w: { taskId: string; picked: Detail },
  lease: { leaseId: unknown },
): Promise<{ runId: string; askId: string }> {
  expect(await personCall(w)).toMatchObject({ ok: false, code: 'BUDGET_UNAVAILABLE' });
  const { run_id: runId } = await one<{ run_id: string }>(
    `select run_id from public.leases where id = $1`,
    [lease.leaseId],
  );
  const { id: askId } = await one<{ id: string }>(
    `select id from public.budget_asks where run_id = $1`,
    [runId],
  );
  return { runId, askId };
}

/** The effect applied, then one call settles and the next stops the run at its ceiling. */
export async function stoppedAfterItsEffect(): Promise<{
  w: PersonWork;
  lease: Lease;
  runId: string;
  askId: string;
}> {
  const { w, lease } = await appliedWithOneCall();
  return { w, lease, ...(await stopIt(w, lease)) };
}

/** Observed at a priced cost above the hold, which is kept whole for a person. */
export const observeOver = async (w: { attemptId: string }, lease: Lease): Promise<string> =>
  codeOf(
    await asPerson(s, {
      command: 'task.observe',
      operationId: randomUUID(),
      ...lease,
      attemptId: w.attemptId,
      usage: PRICED,
    }),
  );

/** A budget-stop answer through the command entry, as `who`: the refusal, or applied. */
export const answerOf = async (
  who: Member,
  body: Record<string, unknown>,
): Promise<CommandRefusal | 'applied'> => {
  const out = await executeCommand(s.db.app, s.business, who.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);
  return isCommandRefusal(out) ? out : 'applied';
};

/** A budget-stop answer through the command entry, as `who`: the refusal's code, or applied. */
export const answer = async (who: Member, body: Record<string, unknown>): Promise<string> => {
  const out = await answerOf(who, body);
  return out === 'applied' ? out : out.code;
};

/** The reservations the run has held, any state. */
export const holdsOf = async (runId: string): Promise<number> =>
  (
    await one<{ n: number }>(
      `select count(*)::int as n from public.reservations where run_id = $1`,
      [runId],
    )
  ).n;
