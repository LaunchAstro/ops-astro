// SPDX-License-Identifier: AGPL-3.0-only
//
// #1517: `delegation.revoke` asks its ceiling (the manager's `read` grant among it) before it
// waits on the runtime's task lock. A grant that expires during that wait must refuse the revoke
// and keep nothing: the delegation stays live and no applied event is written.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { agentWorld, codeOf, type AgentWorld } from './agent-fixture.ts';
import { grantTo } from './fixture.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

let world: AgentWorld;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  world = await agentWorld('p1517_revoke', `p1517-${randomUUID().slice(0, 8)}`);
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
  'a delegation revoke whose read grant expired during its task wait revokes nothing',
  async () => {
    const owner = await world.decider(`owner_${randomUUID()}`);
    const picked = await world.pickUp(owner, 'Revoke ceiling wait');
    const manager = await world.decider(`manager_${randomUUID()}`);
    await world.db.app.withBusiness(world.business, async (tx) => {
      await grantTo(tx, manager, 'manage');
    });
    await world.db.admin.execute(
      "update public.grants set expires_at = clock_timestamp() + interval '2 seconds' where id = $1",
      [manager.grants.read],
    );
    const held = await holdTask(picked.taskId);
    const operationId = randomUUID();
    const delegationId = String(picked.detail['delegationId']);
    let revoking: ReturnType<AgentWorld['asPerson']> | undefined;
    try {
      revoking = world.asPerson(manager, {
        command: 'delegation.revoke',
        operationId,
        delegationId,
      });
      await waitingOn(world.db.admin, 'transactionid', 'from public.records');
      await expired('grants', manager.grants.read);
    } finally {
      await held.letGo();
    }
    const answer = await revoking;
    if (answer === undefined) throw new Error('No revoke answer');
    const [kept] = await world.db.admin.execute<{ revoked: boolean; applied: number }>(
      `select revoked_at is not null as revoked,
      (select count(*)::int from public.audit_events where operation_id = $2 and outcome = 'applied') as applied
      from public.delegations where id = $1`,
      [delegationId, operationId],
    );
    expect({ code: codeOf(answer), kept }).toEqual({
      code: 'SCOPE_NOT_GRANTED',
      kept: { revoked: false, applied: 0 },
    });
  },
  30_000,
);
