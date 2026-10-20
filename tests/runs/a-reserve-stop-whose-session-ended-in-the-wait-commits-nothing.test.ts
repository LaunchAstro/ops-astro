// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1, F1 fix (director ruling DIRECTOR-1623-SPLIT-1330): a reserve stop
// that writes its outcome and retires its own work is judged on the caller's
// session after its last wait, not only `run.end`.
//
// Sol's schedule, through the real HTTP agent door: a connection holds the
// run (`planned_runs`, which the reserve locks after the task); a real agent
// `model.call` is admitted on its own session and is seen parked on the run;
// that session is ended on an independent connection and commits; the stop
// is a rate stop (the business's ceiling for the operation is held reached by
// one call in flight) or a budget stop (a reservation under one call's
// maximum); then the run is let go. Two orders: the ending commits while the
// call waits on the run, or the ending holds its session key while the call,
// let go, comes to its final judgement.
//
// Expected: the session refusal `AUTH_SESSION_EXPIRED`, with nothing
// committed: no outcome, the lease and delegation as they were, no call row,
// no budget ask, the money unmoved, no register row and no audit event but
// the refusal's own. Control: the same schedule on a live session commits one
// outcome, one retirement and one audit of the stop.

import { expect, it as vitestIt } from 'vitest';
import { auditAs } from '../../packages/core-commands/src/commands/model-call.ts';
import { REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import { reserveModelCall } from '../../packages/core-custody/src/index.ts';
import type { Answer } from '../api/fixture.ts';
import { ONE_AT_A_TIME } from '../broker/broker-world.ts';
import { holdRows, liveWork, type Holder, type Work } from '../runtime/schedules-harness.ts';
import {
  asAgent,
  auditFromHere,
  boundToTask,
  callBody,
  delegationOf,
  doorBroker,
  durable,
  endSession,
  holdEnding,
  leaseOf,
  noDatabase,
  parkedUnlessAnswered,
  registered,
  s,
  signedIn,
  useDoorWorld,
} from './run-stop-door-world.ts';
import { attemptOfLease } from './run-outcomes-read.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useDoorWorld('sol1623reserve');

type Stop = 'rate' | 'budget';
type Order = 'ended during the run wait' | 'ending held over the judgement';

/**
 * Hold one `ONE_AT_A_TIME` call in flight on work of its own, through the
 * broker's own reserve, and never send it: the business's ceiling for that
 * operation stays reached for the rest of the file.
 */
async function exhaustTheRateCeiling(): Promise<void> {
  const work = await liveWork(s, 'the call in flight', 2_000);
  const reserved = await s.db.app.withBusiness(s.business, async (tx) => {
    const [step] = await tx.query<{ step_id: string }>(
      'select step_id from public.attempts where business_id = $1 and lease_id = $2',
      [tx.businessId, leaseOf(work)],
    );
    return await reserveModelCall(
      tx,
      { actorId: s.agentActorId, delegationId: delegationOf(work), attendedByPersonId: null },
      {
        leaseId: leaseOf(work),
        fence: Number(work.picked['fence']),
        stepId: String(step?.step_id),
        operation: ONE_AT_A_TIME.key,
        fields: boundToTask(work),
      },
      { ...doorBroker(), audit: auditAs(s.agentActorId) },
    );
  });
  if (!reserved.ok) throw new Error(`the call in flight was refused ${reserved.code}`);
}

let exhausted = false;

/** The stop's work: a reservation of 2,000 meets the rate ceiling, one of 300 the budget stop. */
async function workFor(stop: Stop, title: string): Promise<Work> {
  if (stop === 'rate' && !exhausted) {
    await exhaustTheRateCeiling();
    exhausted = true;
  }
  return await liveWork(s, title, stop === 'rate' ? 2_000 : 300);
}

const operationFor = (stop: Stop): string =>
  stop === 'rate' ? ONE_AT_A_TIME.key : REPLAY_COMPOSE.key;

interface Ran {
  readonly reply: Answer;
  readonly operationId: string;
  /** Whether the call came to wait on the ending, in the held order; null in the other. */
  readonly waitedOnTheEnding: boolean | null;
}

/**
 * The schedule: hold the run, admit the call and see it parked there, end
 * (or hold the ending of) its session if asked, then let the run go.
 */
async function schedule(work: Work, stop: Stop, ending: Order | 'none'): Promise<Ran> {
  const as = await signedIn();
  const { runId } = await attemptOfLease(s.db.admin, s.business, leaseOf(work));
  const run = await holdRows(s, 'planned_runs', [runId]);
  const body = callBody(work, operationFor(stop));
  let replying: Promise<Answer> | undefined;
  let held: Holder | undefined;
  try {
    replying = asAgent('/model/call', work, body, as);
    // The call is admitted at the door and waits on the run under the reserve.
    expect(await parkedUnlessAnswered(replying, 'planned_runs', 1), 'parked on the run').toBe(true);
    if (ending === 'ended during the run wait') await endSession(as.sessionId);
    if (ending === 'ending held over the judgement') held = await holdEnding(as.sessionId);
  } finally {
    await run.release();
  }
  let waitedOnTheEnding: boolean | null = null;
  if (held !== undefined) {
    try {
      waitedOnTheEnding = await parkedUnlessAnswered(replying, 'advisory', 1);
    } finally {
      await held.release();
    }
  }
  return { reply: await replying, operationId: body.operationId, waitedOnTheEnding };
}

const ORDERS: readonly Order[] = ['ended during the run wait', 'ending held over the judgement'];
const STOPS: readonly Stop[] = ['rate', 'budget'];

it.each(STOPS.flatMap((stop) => ORDERS.map((order) => [stop, order] as const)))(
  'a retained %s stop, session %s, is refused AUTH_SESSION_EXPIRED and commits nothing',
  async (stop, order) => {
    const work = await workFor(stop, `${stop} stop, session ended`);
    const before = await durable(work);
    const audit = await auditFromHere();
    const { reply, operationId, waitedOnTheEnding } = await schedule(work, stop, order);
    expect(reply.body['code'], JSON.stringify(reply.body)).toBe('AUTH_SESSION_EXPIRED');
    if (order === 'ending held over the judgement') expect(waitedOnTheEnding).toBe(true);
    // Nothing committed: the rows and the money are as they were before the call.
    expect(await durable(work)).toEqual(before);
    expect(before).toMatchObject({
      outcomes: [],
      lease: 'live',
      delegationRevoked: false,
      run: 'claimed',
      calls: [],
      asks: 0,
    });
    const events = await audit();
    expect(events.filter((event) => event.refusal_code !== 'AUTH_SESSION_EXPIRED')).toEqual([]);
    expect(await registered(operationId)).toEqual([]);
  },
);

it.each([
  ['rate', 'cancelled', 'RATE_LIMITED'],
  ['budget', 'budget_wait', 'BUDGET_UNAVAILABLE'],
] as const)(
  'control: a retained %s stop on a live session commits one %s outcome, one retirement and one audit',
  async (stop, outcome, endCode) => {
    const work = await workFor(stop, `${stop} stop, live session`);
    const before = await durable(work);
    const audit = await auditFromHere();
    const { reply, operationId } = await schedule(work, stop, 'none');
    expect(reply.body['code'], JSON.stringify(reply.body)).toBe(endCode);
    const after = await durable(work);
    expect(after.outcomes, 'the stop wrote its outcome').toMatchObject([
      { outcome, end_code: endCode, stop_cause: null },
    ]);
    expect(after).toMatchObject({
      lease: 'released',
      delegationRevoked: true,
      revocationCause: 'work_retired',
      asks: stop === 'budget' ? 1 : 0,
    });
    if (stop === 'budget') expect(after.run).toBe('waiting_budget');
    // The reservation stays held for the person's answer; nothing is spent.
    expect(after.reservationHeldMinor).toBe(before.reservationHeldMinor);
    expect(after.envelopeActualMinor).toBe(before.envelopeActualMinor);
    const stopped = (await audit()).filter(
      (event) => event.command === 'model.call' && event.refusal_code === endCode,
    );
    expect(stopped).toMatchObject([{ operation_id: operationId }]);
    expect(await registered(operationId)).toMatchObject([
      { outcome: 'refused', result: { code: endCode } },
    ]);
  },
);
