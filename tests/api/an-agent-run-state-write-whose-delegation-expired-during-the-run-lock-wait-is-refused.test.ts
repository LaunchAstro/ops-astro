// SPDX-License-Identifier: AGPL-3.0-only
//
// On the agent route, `run.revise_state` resolves the credential's delegation,
// waits for the run row, and resolves the delegation again once it holds it.
// The delegation expires a moment after the write is admitted. A fixture
// transaction holds the run row; the agent's write parks on it while the
// delegation is live; the database's wall clock passes the delegation's
// expiry; then the fixture lets go. The write must be refused
// `DELEGATION_NOT_LIVE` and append no state version: expiry is judged on the
// clock after the wait, not the transaction's start (Sol round 1 on #1010, F3).

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvedReservationId } from '../acceptance/role-case-bodies.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  serverUrl,
  type World,
} from '../acceptance/world.ts';
import { grantTo } from '../commands/fixture.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { asAgent, contextOf, signed, type Signed } from './c54-fixture.ts';

describe.skipIf(serverUrl === undefined)('an agent run-state write across an expiry', () => {
  let world: World;
  let ada: Signed;

  beforeAll(async () => {
    world = await createWorld('agentrunexpiry');
    ada = signed(world.ada);
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, ada, 'write', undefined, false, 'run');
    });
  }, 180_000);

  afterAll(async () => await world?.close());

  it('an agent run-state write whose delegation expired during the run lock wait is refused, and appends nothing', async () => {
    const reservationId = await approvedReservationId(contextOf(world, ada));
    const picked = await call(
      world.api,
      agentPath('alpha', '/task/pickup'),
      { operationId: randomUUID(), reservationId },
      bearer(world.agent.token),
    );
    if (picked.code !== 'ok') throw new Error(`agent pickup refused ${picked.code}`);
    const detail = picked.body['detail'] as Record<string, unknown>;
    const taskId = String(detail['taskId']);
    const [run] = await world.db.admin.execute<{ readonly run_id: string }>(
      `select run_id from public.reservations where id = $1`,
      [reservationId],
    );
    const runId = String(run?.run_id);
    const row = await hold(world.db.appUrl, world.alpha, async (tx) => {
      await tx.query(
        'select id from public.planned_runs where business_id = $1 and id = $2 for update',
        [tx.businessId, runId],
      );
    });
    let writing: ReturnType<typeof asAgent> | undefined;
    try {
      const [delegation] = await world.db.admin.execute<{ readonly id: string }>(
        `update public.delegations set expires_at = clock_timestamp() + interval '3 seconds'
          where id = (select delegation_id from public.leases where id = $1) returning id`,
        [String(detail['leaseId'])],
      );
      writing = asAgent(
        world,
        'run.revise_state',
        { recordId: taskId, runId, expectedVersion: 0, knowledge: ['race text'], unknowns: [] },
        String(detail['credential']),
      );
      await waitingOn(world.db.admin, 'transactionid', 'select id from public.planned_runs');
      // Admitted while the delegation was live: the waiter's transaction began before expiry.
      const [admitted] = await world.db.admin.execute<{ readonly live: boolean }>(
        `select bool_and(a.xact_start < d.expires_at) as live
           from pg_stat_activity a, public.delegations d
          where d.id = $1 and a.wait_event_type = 'Lock'
            and strpos(a.query, 'select id from public.planned_runs') > 0`,
        [delegation?.id],
      );
      expect(admitted?.live, 'the write was admitted before the delegation expired').toBe(true);
      for (let look = 0; look < 500; look += 1) {
        // oxlint-disable-next-line no-await-in-loop -- polls the clock, one look at a time
        const [past] = await world.db.admin.execute<{ readonly past: boolean }>(
          'select clock_timestamp() > expires_at as past from public.delegations where id = $1',
          [delegation?.id],
        );
        if (past?.past === true) break;
        // oxlint-disable-next-line no-await-in-loop -- polls the clock, one look at a time
        await delay(20);
      }
    } finally {
      await row.letGo();
    }
    const answer = await writing;
    const versions = await world.db.admin.execute<{ n: number }>(
      'select count(*)::int as n from public.run_states where run_id = $1',
      [runId],
    );
    expect({ answer: answer.code, versions: versions[0]?.n }).toEqual({
      answer: 'DELEGATION_NOT_LIVE',
      versions: 0,
    });
  });
});
