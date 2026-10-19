// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R3 with owner line 72: a turn's subscription send is judged again at
// custody's handoff from the rows, as a fields call is. A task an agent's
// write made outside after the start committed is not admitted to the
// subscription's cloud route. Proof by Sol (GPT-6.1-Sol), review of #1900,
// finding S1900-2; assertions unchanged.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REPLAY_TURN } from '../../packages/core-connectors/src/index.ts';
import { taskAdmission } from '../../packages/core-custody/src/broker-admission.ts';
import { reserveModelCall } from '../../packages/core-custody/src/broker-reserve.ts';
import { serverUrl } from '../acceptance/world.ts';
import { liveWork, rows, type Work } from '../runtime/schedules-harness.ts';
import { s, useDoorWorld } from './run-stop-door-world.ts';
import { taskPart, turnBroker } from './turn-world.ts';

/** The turn broker's cloud routes, each as a subscription's. */
function subscriptionBroker() {
  const broker = turnBroker(3)();
  const routes: (typeof broker.routes)[number][] = [];
  for (const route of broker.routes) {
    if (route.reach === 'cloud') routes.push({ ...route, credentialKind: 'subscription' });
  }
  return { ...broker, routes, audit: async () => {} };
}

/** A turn 0 request on `work`'s lease, as the agent sends it. */
async function turnRequest(work: Work) {
  const leaseId = String(work.picked['leaseId']);
  const [attempt] = await rows<{ step_id: string }>(
    s,
    'select step_id from public.attempts where business_id=$1 and lease_id=$2',
    [s.business, leaseId],
  );
  return {
    leaseId,
    fence: Number(work.picked['fence']),
    stepId: String(attempt?.step_id),
    operation: REPLAY_TURN.key,
    fields: [],
    turn: { turnOrdinal: 0, tools: ['task.read'], parts: [await taskPart(work)] },
  };
}

describe.skipIf(serverUrl === undefined)('a turn at the subscription handoff', () => {
  useDoorWorld('r3handoff', turnBroker(3));

  it('refuses a task reclassified outside after the start', async () => {
    const work = await liveWork(s, 'r3 handoff', 2000);
    const request = await turnRequest(work);
    const reservation = await s.db.app.withBusiness(
      s.business,
      async (tx) =>
        await reserveModelCall(
          tx,
          {
            actorId: s.agentActorId,
            delegationId: String(work.picked['delegationId']),
            attendedByPersonId: s.decider.personId,
          },
          request,
          subscriptionBroker(),
        ),
    );
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) throw new Error('setup reserve failed');
    await s.db.admin.execute(
      "update public.model_calls set state='dispatched', started_at=clock_timestamp() where business_id=$1 and id=$2",
      [s.business, reservation.reserved.callId],
    );
    // An agent write makes the task outside after the start's transaction committed.
    await s.db.admin.execute(
      "insert into public.operations (business_id,id,operation_id,actor_id,command,record_id,outcome,payload_digest,result) values ($1,gen_random_uuid(),$2,$3,'task.update',$4,'applied',repeat('0',64),'{}')",
      [s.business, randomUUID(), s.agentActorId, work.taskId],
    );
    const admission = await taskAdmission(s.db.app, s.business, request, reservation.reserved)();
    admission?.end();
    // Wait for the admission transaction to release its locks.
    await s.db.app.withBusiness(s.business, async (tx) => await tx.query('select 1'));
    expect(
      admission,
      'outside task must not be admitted to the subscription cloud route',
    ).toBeUndefined();
  }, 60000);
});
