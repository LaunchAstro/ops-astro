// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1, design F1: a stop that retires its own authority still commits.
//
// `run.end` is the worker's stop for what only it can see. It writes the
// attempt's outcome and retires the work (lease released, delegation revoked)
// in one transaction, so an applied answer would be undone by the agent
// standing check it runs after the handler (`workJudged`): the delegation it
// is judged on is the one it just revoked. It answers instead as a retained
// terminal refusal, `RUN_ENDED` carrying the outcome and code, which commits
// with its writes and is registered under its operation id.
//
// Through the real HTTP agent door, after one settled replay call: `run.end`
// with `TOOL_REFUSED` is `RUN_ENDED`, one `cancelled / TOOL_REFUSED` row,
// the delegation revoked and the lease released; the same operation id
// replays `RUN_ENDED`, and the same id with other operands is
// `OPERATION_ID_REUSED`. A delegation revoked, or a session ended, on a second
// connection while `run.end` waits on its locks commits nothing, in both
// orders. Controls: the same wait with nothing changed commits the stop, and
// an ordinary permitted call by a live attempt commits normally.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { revokeDelegation } from '../../packages/core-records/src/index.ts';
import type { Answer } from '../api/fixture.ts';
import { awaitParked, holdRows, liveWork, type Work } from '../runtime/schedules-harness.ts';
import {
  asAgent,
  auditFromHere,
  callBody,
  delegationOf,
  durable,
  endSession,
  holdEnding,
  independently,
  noDatabase,
  parkedUnlessAnswered,
  registered,
  s,
  leaseOf,
  signedIn,
  useDoorWorld,
  world,
  type Sent,
  type SignedIn,
} from './sol-1623-door-world.ts';
import { attemptOfLease } from './run-outcomes-read.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useDoorWorld('sol1623runend');

/** A `run.end` body as design "Data shapes" has it: the worker names a code, never an outcome. */
const endBody = (work: Work, endCode: string, operationId: string = randomUUID()): Sent => ({
  operationId,
  leaseId: work.picked['leaseId'],
  fence: work.picked['fence'],
  endCode,
});

/** Revoke the delegation on an independent connection, and commit. */
async function revokeOn(delegationId: string): Promise<void> {
  await (await independently(async (tx) => await revokeDelegation(tx, delegationId))).release();
}

/** Live work with one replay call already settled on it, as the worker would have it. */
async function settledOnce(title: string, as: SignedIn): Promise<Work> {
  const work = await liveWork(s, title, 2_000);
  world.provider.mode('answer');
  const answered = await asAgent('/model/call', work, callBody(work), as);
  expect(answered.body['detail'], JSON.stringify(answered.body)).toMatchObject({
    state: 'settled',
  });
  return work;
}

const runOf = async (work: Work): Promise<string> =>
  (await attemptOfLease(s.db.admin, s.business, leaseOf(work))).runId;

it('Sol 1623 F1: run.end TOOL_REFUSED after a settled call answers RUN_ENDED, and its stop commits once', async () => {
  const as = await signedIn();
  const work = await settledOnce('ends on a refused tool', as);
  const audit = await auditFromHere();
  const body = endBody(work, 'TOOL_REFUSED');
  const ended = await asAgent('/run/end', work, body, as);
  expect(ended.body['code'], `${String(ended.status)} ${JSON.stringify(ended.body)}`).toBe(
    'RUN_ENDED',
  );
  expect(ended.body['names']).toEqual(['cancelled', 'TOOL_REFUSED']);
  const after = await durable(work);
  expect(after.outcomes).toMatchObject([
    { outcome: 'cancelled', end_code: 'TOOL_REFUSED', stop_cause: null },
  ]);
  expect(after).toMatchObject({
    lease: 'released',
    delegationRevoked: true,
    revocationCause: 'work_retired',
    calls: [{ state: 'settled', refusal_code: null }],
  });
  // The register row and the audit event of the stop committed with it.
  expect(await registered(body.operationId)).toMatchObject([
    { outcome: 'refused', result: { code: 'RUN_ENDED', names: ['cancelled', 'TOOL_REFUSED'] } },
  ]);
  expect((await audit()).filter((event) => event.operation_id === body.operationId)).toMatchObject([
    { command: 'run.end', outcome: 'refused', refusal_code: 'RUN_ENDED' },
  ]);

  // The same operation id replays the stored stop; nothing is written again.
  const again = await asAgent('/run/end', work, body, as);
  expect(again.body).toMatchObject({ code: 'RUN_ENDED', names: ['cancelled', 'TOOL_REFUSED'] });
  // The same id with other operands is a reuse, never a second stop.
  const reused = await asAgent(
    '/run/end',
    work,
    endBody(work, 'TOOL_NOT_CATALOGUED', body.operationId),
    as,
  );
  expect(reused.body['code']).toBe('OPERATION_ID_REUSED');
  expect(await durable(work)).toEqual(after);
});

type Change = 'delegation revoked' | 'session ended';
type Order = 'while it waits on the run' | 'queued ahead of it';

/**
 * Two orders. "While it waits on the run": the run is held, `run.end` parks
 * on it, and the change commits before the run is let go. "Queued ahead of
 * it": a revocation queues on the delegation before `run.end` does, or the
 * ending holds the session key while `run.end`, let go, comes to judge it.
 */
async function racedEnd(work: Work, as: SignedIn, change: Change, order: Order) {
  const body = endBody(work, 'TOOL_REFUSED');
  let established = false;
  if (order === 'queued ahead of it' && change === 'delegation revoked') {
    const delegation = await holdRows(s, 'delegations', [delegationOf(work)]);
    let ending: Promise<Answer> | undefined;
    let revoking: Promise<void> | undefined;
    try {
      revoking = revokeOn(delegationOf(work));
      await awaitParked(s, 'delegations', 1);
      ending = asAgent('/run/end', work, body, as);
      established = await parkedUnlessAnswered(ending, 'delegations', 2);
    } finally {
      await delegation.release();
    }
    await revoking;
    return { body, reply: await ending, established };
  }
  const run = await holdRows(s, 'planned_runs', [await runOf(work)]);
  let ending: Promise<Answer> | undefined;
  let held: Awaited<ReturnType<typeof holdEnding>> | undefined;
  try {
    ending = asAgent('/run/end', work, body, as);
    established = await parkedUnlessAnswered(ending, 'planned_runs', 1);
    if (established) {
      if (change === 'delegation revoked') await revokeOn(delegationOf(work));
      else if (order === 'while it waits on the run') await endSession(as.sessionId);
      else held = await holdEnding(as.sessionId);
    }
  } finally {
    await run.release();
  }
  if (held !== undefined) {
    try {
      established = await parkedUnlessAnswered(ending, 'advisory', 1);
    } finally {
      await held.release();
    }
  }
  return { body, reply: await ending, established };
}

const CHANGES: readonly (readonly [Change, string])[] = [
  ['delegation revoked', 'DELEGATION_NOT_LIVE'],
  ['session ended', 'AUTH_SESSION_EXPIRED'],
];
const ORDERS: readonly Order[] = ['while it waits on the run', 'queued ahead of it'];

it.each(CHANGES.flatMap(([change, code]) => ORDERS.map((order) => [change, order, code] as const)))(
  'Sol 1623 F1: run.end whose %s %s commits no stop',
  async (change, order, code) => {
    const as = await signedIn();
    const work = await settledOnce(`ends, ${change}`, as);
    const before = await durable(work);
    const audit = await auditFromHere();
    const { body, reply, established } = await racedEnd(work, as, change, order);
    expect(reply.body['code'], `${String(reply.status)} ${JSON.stringify(reply.body)}`).toBe(code);
    expect(established, 'run.end waited where the order puts it').toBe(true);
    const after = await durable(work);
    expect(after.outcomes, 'no outcome was recorded').toEqual([]);
    // Only the external change moved anything: the lease is live and the call as it was.
    expect(after).toEqual({
      ...before,
      ...(change === 'delegation revoked'
        ? { delegationRevoked: true, revocationCause: 'delegation_revoked' }
        : {}),
    });
    expect(await registered(body.operationId)).toEqual([]);
    expect((await audit()).map((event) => event.refusal_code)).not.toContain('RUN_ENDED');
  },
);

it('Sol 1623 F1 control: run.end that waited on the run with nothing changed commits its stop', async () => {
  const as = await signedIn();
  const work = await settledOnce('ends after a wait', as);
  const body = endBody(work, 'TOOL_REFUSED');
  const run = await holdRows(s, 'planned_runs', [await runOf(work)]);
  let ending: Promise<Answer> | undefined;
  let waited = false;
  try {
    ending = asAgent('/run/end', work, body, as);
    waited = await parkedUnlessAnswered(ending, 'planned_runs', 1);
  } finally {
    await run.release();
  }
  const reply = await ending;
  expect(reply.body['code'], `${String(reply.status)} ${JSON.stringify(reply.body)}`).toBe(
    'RUN_ENDED',
  );
  expect(waited, 'run.end waited on the run').toBe(true);
  expect(await durable(work)).toMatchObject({
    outcomes: [{ outcome: 'cancelled', end_code: 'TOOL_REFUSED' }],
    lease: 'released',
    delegationRevoked: true,
  });
});

it('Sol 1623 F1 control: an ordinary permitted call by a live attempt commits normally', async () => {
  const as = await signedIn();
  const work = await liveWork(s, 'an ordinary call', 2_000);
  world.provider.mode('answer');
  const body = callBody(work);
  const answered = await asAgent('/model/call', work, body, as);
  expect(answered.status).toBe(200);
  expect(answered.body['detail']).toMatchObject({ state: 'settled', text: 'Drafted.' });
  expect(await durable(work)).toMatchObject({
    outcomes: [],
    lease: 'live',
    delegationRevoked: false,
    calls: [{ state: 'settled', refusal_code: null }],
  });
  expect(await registered(body.operationId)).toMatchObject([{ outcome: 'applied' }]);
});
