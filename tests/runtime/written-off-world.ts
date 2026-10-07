// SPDX-License-Identifier: AGPL-3.0-only
//
// The steps the written-off-hold proofs share (`top-up-on-a-written-off-hold`,
// `written-off-while-dispatched`, `room-after-a-counted-write-off`): the
// broker's own late answer to a call, the step's attempt, custody's reading of
// a counted hold, and the answers on a run.

import { catalogue, REPLAY_COMPOSE } from '../../packages/core-connectors/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import { COUNTED_CAUSES, countedHold } from '../../packages/core-custody/src/broker-give-back.ts';
import { settle, type Settlement } from '../../packages/core-custody/src/broker-settle.ts';
import { CLOUD } from '../broker/broker-world.ts';
import { rows, type Detail, type Schedules } from './schedules-harness.ts';

const UNUSED = (): never => {
  throw new Error('the late answer dispatches nothing');
};
// Not annotated, so custody's other members (`describe` on main) need no listing here.
const NO_CUSTODY = { pid: 0, dispatch: UNUSED, describe: UNUSED, stderr: () => '', raw: UNUSED };
/** A broker with no provider and no custody: it settles a late answer and asks no lookup. */
export const LATE_BROKER: Broker = {
  custody: { ...NO_CUSTODY, kill: UNUSED, stop: UNUSED },
  operations: catalogue([REPLAY_COMPOSE]),
  providers: new Map(),
  routes: [CLOUD],
  installation: 'here',
  audit: async () => await Promise.resolve(),
};
const LATE_ANSWER = { text: 'late', model: null, usage: { inputUnits: 1, outputUnits: 1 } };

/** The broker's own settle of a call sent under `picked`'s lease, as its late answer says. */
export async function answerLate(
  s: Schedules,
  picked: Detail,
  callId: string,
  settlement: Settlement,
): Promise<void> {
  const operation = LATE_BROKER.operations.get(REPLAY_COMPOSE.key);
  const [call] = await rows<{ reserved: string }>(
    s,
    'select reserved_minor::text as reserved from public.model_calls where id = $1',
    [callId],
  );
  if (operation === undefined || call === undefined) throw new Error('answerLate: no call');
  const { leaseId, fence, delegationId } = picked;
  await settle(
    s.db.app,
    s.business,
    { actorId: s.agentActorId, delegationId: String(delegationId), attendedByPersonId: null },
    {
      leaseId: String(leaseId),
      fence: Number(fence),
      stepId: '',
      operation: operation.key,
      fields: [],
    },
    { callId, operation, route: CLOUD, reservedMinor: Number(call.reserved) },
    settlement,
    LATE_BROKER,
  );
}

/** A late answer priced at `cost`. */
export const priced = (cost: number): Settlement => ({
  kind: 'priced',
  answer: { ...LATE_ANSWER, providerCode: null },
  costMinor: cost,
  account: null,
  credentialKind: 'replay',
});

export async function attemptOf(s: Schedules, reservationId: unknown): Promise<string> {
  const [found] = await rows<{ id: string }>(
    s,
    'select id from public.attempts where business_id = $1 and reservation_id = $2',
    [s.business, reservationId],
  );
  if (found === undefined) throw new Error('attemptOf: no attempt');
  return found.id;
}

/** Custody's own reading: the hold counted its open calls at their maximum. */
export async function counted(s: Schedules, reservationId: unknown): Promise<boolean | undefined> {
  const [found] = await rows<{ counted: boolean }>(
    s,
    `select ${countedHold('$3')} as counted from public.reservations r
      where r.business_id = $1 and r.id = $2`,
    [s.business, reservationId, COUNTED_CAUSES],
  );
  return found?.counted;
}

export async function answersOn(s: Schedules, runId: string): Promise<number> {
  const [found] = await rows<{ n: string }>(
    s,
    'select count(*)::text as n from public.budget_answers where business_id = $1 and run_id = $2',
    [s.business, runId],
  );
  return Number(found?.n);
}
