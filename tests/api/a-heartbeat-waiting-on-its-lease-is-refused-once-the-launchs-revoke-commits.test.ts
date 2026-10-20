// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proofs on #2180 (COV2180), made two-connection: a pickup child reads
// only its own purpose, and a heartbeat already waiting on its lease when the
// owner's revoke of the launch commits is refused, renewing nothing (#2195).

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerLaunchWorld, applied, type OwnerLaunchWorld } from './owner-launch-world.ts';
import { grantTo } from '../commands/fixture.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { authorised, BUSINESS_KEY, post, tokenFor } from './fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- Sol's two proofs, unchanged
describe.skipIf(serverUrl === undefined)('a pickup child under a taken launch', () => {
  let w: OwnerLaunchWorld;
  beforeEach(async () => {
    w = await ownerLaunchWorld('launchrevokewait');
  }, 180_000);
  afterEach(async () => {
    await w?.fixture.drop();
  });

  async function pickup() {
    const taskId = await w.ownersPlan(`Launch revoke wait ${randomUUID()}`);
    const launchCredential = await w.takenLaunch(taskId);
    const picked = applied(
      await w.asAgent(
        'task.pickup',
        {
          operationId: randomUUID(),
          reservationId: await w.reservationOn(taskId),
        },
        launchCredential,
      ),
    );
    return { taskId, picked, credential: String(picked['credential']) };
  }

  it('reads only its own purpose and capabilities, chained to the launch', async () => {
    const { taskId, picked, credential } = await pickup();
    const before = await w.footprint();
    const caps = applied(
      await w.asAgent(
        'session.capabilities',
        {
          operationId: randomUUID(),
        },
        credential,
      ),
    );
    expect(caps['purposeScope']).toEqual({ kind: 'record', id: taskId });
    expect(caps['agentActorId']).toBe(w.fixture.agentActorId);
    expect(caps['grants']).toEqual([
      { collection: 'task', action: 'read' },
      { collection: 'task', action: 'write' },
      { collection: 'run', action: 'write' },
    ]);
    expect(await w.footprint()).toEqual(before);
    const [chain] = await w.fixture.db.admin.execute<{
      parent_matches: boolean;
      within_expiry: boolean;
      task_matches: boolean;
    }>(
      `select c.parent_delegation_id = l.delegation_id as parent_matches,
              c.expires_at <= p.expires_at as within_expiry,
              c.purpose_scope_id = l.task_id as task_matches
         from public.delegations c
         join public.task_launches l on l.business_id = c.business_id and l.task_id = c.purpose_scope_id
         join public.delegations p on p.business_id = l.business_id and p.id = l.delegation_id
        where c.business_id = $1 and c.id = $2`,
      [w.fixture.business, picked['delegationId']],
    );
    expect(chain).toEqual({ parent_matches: true, within_expiry: true, task_matches: true });
  });

  // The blocker holds the lease on its own connection and the served API runs
  // on a two-connection pool, so the heartbeat really waits on the lease lock
  // while the revoke commits; the two backends are asserted different.
  // eslint-disable-next-line max-lines-per-function -- one race, set up and judged in order
  it('refuses a heartbeat that was waiting on its lease when the launch revoke committed', async () => {
    const { taskId, picked, credential } = await pickup();
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, w.fixture.member, 'manage');
      await grantTo(tx, w.fixture.member, 'manage', undefined, false, 'access');
    });
    const [launch] = await w.fixture.db.admin.execute<{ delegation_id: string }>(
      'select delegation_id from public.task_launches where business_id = $1 and task_id = $2',
      [w.fixture.business, taskId],
    );
    const pool = connect(w.fixture.db.appUrl, { max: 2 });
    const side = connect(w.fixture.db.appUrl);
    const api = w.fixture.compose(undefined, undefined, pool);
    const ownerToken = await tokenFor(w.fixture.member.presented.subject);
    const agentToken = await tokenFor(w.fixture.agent.subject);
    let release!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const free = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = side.withBusiness(w.fixture.business, async (tx) => {
      const [me] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      await tx.query('select 1 from public.leases where business_id = $1 and id = $2 for update', [
        w.fixture.business,
        picked['leaseId'],
      ]);
      ready(Number(me!.pid));
      await free;
    });
    let heartbeat: Promise<{ status: number; body: Record<string, unknown> }> | undefined;
    let early: { status: number; code: unknown } | undefined;
    let waiterPid: number | undefined;
    let blockerPid = -1;
    try {
      blockerPid = await held;
      heartbeat = post(
        api,
        `/api/a/b/${BUSINESS_KEY}${pathOf('task.heartbeat')}`,
        {
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          leaseSeconds: 3600,
        },
        { ...authorised(agentToken), 'x-agent-delegation': credential },
      );
      void heartbeat.then((answer) => {
        early = { status: answer.status, code: answer.body['code'] };
        return answer;
      });
      await expect
        .poll(
          async () => {
            if (early !== undefined)
              throw new Error(`heartbeat finished before the lock: ${JSON.stringify(early)}`);
            const rows = await w.fixture.db.admin.execute<{ pid: number }>(
              `select pid from pg_stat_activity where datname = current_database()
             and state = 'active' and wait_event_type = 'Lock'
             and query like '%public.leases%' and query like '%for update%'`,
            );
            waiterPid = rows[0] === undefined ? undefined : Number(rows[0].pid);
            return rows.length;
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(0);
      expect(waiterPid).not.toBe(blockerPid);
      const revoked = await post(
        api,
        `/api/b/${BUSINESS_KEY}${pathOf('delegation.revoke')}`,
        {
          operationId: randomUUID(),
          delegationId: launch!.delegation_id,
        },
        authorised(ownerToken),
      );
      expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
      const [row] = await w.fixture.db.admin.execute<{ revoked: boolean }>(
        'select revoked_at is not null as revoked from public.delegations where business_id = $1 and id = $2',
        [w.fixture.business, launch!.delegation_id],
      );
      expect(row?.revoked).toBe(true);
    } finally {
      release();
      await blocker;
    }
    const answer = await heartbeat!;
    console.log(
      `launch revoke wait backends: blocker ${blockerPid}, waiting heartbeat ${waiterPid}; heartbeat ${answer.status} ${String(answer.body['code'])}`,
    );
    await pool.close();
    await side.close();
    expect({ status: answer.status, code: answer.body['code'] }).toEqual({
      status: 403,
      code: 'DELEGATION_REVOKED',
    });
    const [lease] = await w.fixture.db.admin.execute<{ expires_at: Date }>(
      'select expires_at from public.leases where business_id = $1 and id = $2',
      [w.fixture.business, picked['leaseId']],
    );
    expect(lease!.expires_at.toISOString()).toBe(picked['expiresAt']);
  }, 60_000);
});
