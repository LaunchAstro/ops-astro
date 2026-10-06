// SPDX-License-Identifier: AGPL-3.0-only
//
// On the agent route, `run.revise_state` is admitted under the delegation the
// credential resolved before its handler locks the run. A fixture transaction
// holds the run row; the agent's write is admitted and parks on it; the
// delegation is revoked and commits; then the fixture lets go. The write must
// be refused `DELEGATION_NOT_LIVE` and append no state version: the
// delegation is resolved again under the lock, not judged as first read.

import { randomUUID } from 'node:crypto';
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

describe.skipIf(serverUrl === undefined)('an agent run-state write across a revocation', () => {
  let world: World;
  let ada: Signed;

  beforeAll(async () => {
    world = await createWorld('agentrunrevoke');
    ada = signed(world.ada);
    // ada holds run:write, so the delegation the pickup mints carries `run`.
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await grantTo(tx, ada, 'write', undefined, false, 'run');
    });
  }, 180_000);

  afterAll(async () => await world?.close());

  it('an agent run-state write whose delegation was revoked during the run lock wait is refused, and appends nothing', async () => {
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
      writing = asAgent(
        world,
        'run.revise_state',
        { recordId: taskId, runId, expectedVersion: 0, knowledge: ['race text'], unknowns: [] },
        String(detail['credential']),
      );
      await waitingOn(world.db.admin, 'transactionid', 'select id from public.planned_runs');
      const revoked = await world.db.admin.execute(
        `update public.delegations set revoked_at = now()
          where id = (select delegation_id from public.leases where id = $1) returning id`,
        [String(detail['leaseId'])],
      );
      expect(revoked).toHaveLength(1);
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
