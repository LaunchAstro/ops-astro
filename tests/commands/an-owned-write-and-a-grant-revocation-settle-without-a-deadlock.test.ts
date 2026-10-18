// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof S1882-1 on #1882 (criterion 3), renamed for what it proves and guarded
// for a run without a database, otherwise as written. An agent update paused after its
// task lock while `grant.revoke` waits on that lock settles with no deadlock, and the
// grant hold reads no other business's grants.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  connect,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/index.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { aiWorld, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { enrol, grantTo } from './fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { holdCoveringGrants } from '../../packages/core-runtime/src/index.ts';
import { latch } from '../support/lock-wait-race.ts';
import { serverUrl } from '../acceptance/world.ts';
let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('owned_write_revoke_order');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});
it.skipIf(serverUrl === undefined)(
  'an owned agent write paused after its task lock and a grant revocation waiting on it settle without a deadlock',
  // oxlint-disable-next-line max-lines-per-function -- Sol's proof as written: the pause, the waiter and both outcomes
  async () => {
    await w.world.db.app.withBusiness(w.world.business, (tx) =>
      grantTo(tx, w.p, 'write', { kind: 'business', id: null }, false, 'run'),
    );
    const picked = await w.world.pickUp(w.p, 'lock ordering');
    const revision = await revisionOf(w, picked.taskId);
    const deadlocks: string[] = [];
    const original = w.world.db.app.withBusiness;
    w.world.db.app.withBusiness = async (businessId, run) => {
      try {
        return await original(businessId, run);
      } catch (error) {
        if ((error as { code?: string }).code === '40P01') deadlocks.push('grant.revoke');
        throw error;
      }
    };
    const reached = latch();
    const resume = latch();
    const db = connect(w.world.db.appUrl);
    let updatePid = 0;
    const intercepted: Database = {
      log: db.log,
      close: () => db.close(),
      withBusiness: (businessId, run) =>
        db.withBusiness(businessId, async (tx) => {
          const [backend] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
          updatePid = backend!.pid;
          const wrapped: TransactionQuery = {
            businessId: tx.businessId,
            savepoint: (work) => tx.savepoint(work),
            query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
              let rows: readonly Row[];
              try {
                rows = await tx.query<Row>(sql, parameters);
              } catch (error) {
                if ((error as { code?: string }).code === '40P01') deadlocks.push('task.update');
                throw error;
              }
              if (
                sql.includes('revision::text as revision') &&
                sql.includes('for update') &&
                parameters?.includes(picked.taskId)
              ) {
                reached.open();
                await resume.promise;
              }
              return rows;
            },
          };
          return await run(wrapped);
        }),
    };
    const changing = executeAgentCommand(
      intercepted,
      w.world.business,
      { provider: 'supabase', subject: w.world.agentSubject() },
      picked.credential,
      {
        command: 'task.update',
        operationId: randomUUID(),
        recordId: picked.taskId,
        expectedRevision: revision,
        fields: { title: 'updated' },
      },
    );
    const observed = changing.then(
      () => 'fulfilled',
      (error: { code?: string }) => error.code ?? 'rejected',
    );
    let revoking: Promise<unknown> | undefined;
    try {
      await reached.promise;
      revoking = w.world.revokeGrant(w.p.grants.write);
      // Observe the real grant.revoke transaction waiting for our task lock.
      await expect
        .poll(
          async () => {
            const [row] = await w.world.db.admin.execute<{ blocked: boolean }>(
              `select exists(select 1 from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and $1::int = any(pg_blocking_pids(pid))) as blocked`,
              [updatePid],
            );
            return row?.blocked;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      resume.open();
      const results = await Promise.allSettled([observed, revoking]);
      expect(
        deadlocks,
        'Opposite task/grant lock ordering must not require a deadlock retry',
      ).toEqual([]);
      expect(results).toEqual([
        { status: 'fulfilled', value: 'fulfilled' },
        { status: 'fulfilled', value: undefined },
      ]);
    } finally {
      resume.open();
      await Promise.allSettled([changing, revoking]);
      w.world.db.app.withBusiness = original;
      await db.close();
    }
  },
  30_000,
);

it.skipIf(serverUrl === undefined)(
  'the covering grant hold reads no grant of another business',
  async () => {
    const business = await insertBusiness(w.world.db.app, `foreign-${randomUUID().slice(0, 8)}`);
    const person = await enrol(w.world.db.app, business, 'foreign');
    await w.world.db.app.withBusiness(business, (tx) => grantTo(tx, person, 'write'));
    const held = await w.world.db.app.withBusiness(w.world.business, (tx) =>
      holdCoveringGrants(tx, [{ kind: 'person', id: person.personId }], 'task'),
    );
    expect(held).toEqual([]);
  },
);
