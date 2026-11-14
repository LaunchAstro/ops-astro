// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one lock wait read top to bottom */
//
// #1518: an agent's `task.propose` resolves its delegation before the task lock. A delegation
// that expires during that wait must refuse the proposal (`DELEGATION_NOT_LIVE`) and write
// nothing.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { agentWorld, codeOf, type AgentWorld } from './agent-fixture.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

let world: AgentWorld;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  world = await agentWorld('p1518_propose', `p1518-${randomUUID().slice(0, 8)}`);
}, 180_000);
afterAll(async () => {
  await world?.drop();
});

async function holdTask(id: string) {
  return await hold(world.db.appUrl, world.business, async (tx) => {
    await tx.query('select id from public.records where business_id = $1 and id = $2 for update', [
      world.business,
      id,
    ]);
  });
}

async function expired(table: 'grants' | 'delegations', id: string) {
  for (let n = 0; n < 100; n += 1) {
    // eslint-disable-next-line no-await-in-loop -- polling the database clock, one read at a time
    const [row] = await world.db.admin.execute<{ expired: boolean }>(
      `select expires_at <= clock_timestamp() as expired from public.${table} where id = $1`,
      [id],
    );
    if (row?.expired === true) return;
    // eslint-disable-next-line no-await-in-loop -- polling the database clock, one read at a time
    await delay(50);
  }
  throw new Error('Expiry was not reached');
}

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'an agent proposal on a delegation that expired during its task wait is refused',
  async () => {
    const owner = await world.decider(`owner_${randomUUID()}`);
    const picked = await world.pickUp(owner, 'Propose delegation wait');
    const delegationId = String(picked.detail['delegationId']);
    const [record] = await world.db.admin.execute<{ revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [picked.taskId],
    );
    const [lineage] = await world.db.admin.execute<{ id: string }>(
      'select id from public.proposal_lineages where task_id = $1',
      [picked.taskId],
    );
    await world.db.admin.execute(
      "update public.delegations set expires_at = clock_timestamp() + interval '2 seconds' where id = $1",
      [delegationId],
    );
    const held = await holdTask(picked.taskId);
    const operationId = randomUUID();
    let proposing: ReturnType<AgentWorld['asAgent']> | undefined;
    try {
      proposing = world.asAgent(
        {
          command: 'task.propose',
          operationId,
          recordId: picked.taskId,
          expectedRevision: Number(record?.revision),
          lineageId: lineage?.id,
          purpose: `proposal_${randomUUID().slice(0, 8)}`,
          maximumMinor: 3000,
          currency: 'AUD',
          payload: { instruction: 'proposed after expiry' },
          step: { kind: 'compose', payload: {} },
        },
        picked.credential,
      );
      await waitingOn(world.db.admin, 'transactionid', 'from public.records');
      await expired('delegations', delegationId);
    } finally {
      await held.letGo();
    }
    const answer = await proposing;
    if (answer === undefined) throw new Error('No proposal answer');
    const [events] = await world.db.admin.execute<{ applied: number }>(
      "select count(*)::int as applied from public.audit_events where operation_id = $1 and outcome = 'applied'",
      [operationId],
    );
    expect({ code: codeOf(answer), applied: events?.applied }).toEqual({
      code: 'DELEGATION_NOT_LIVE',
      applied: 0,
    });
  },
  30_000,
);
