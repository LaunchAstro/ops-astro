// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, no-await-in-loop, no-promise-executor-return, no-shadow -- Sol's proofs, copied; the session count follows the wait chain */
//
// C57 part B (#2117), Sol's proofs for S2143-2, S2143-3 and S2143-4: a lease that runs out while
// the task waits for its placement, or for the audit chain's lock, makes no task and leaves the
// request pending, and the two calls the one-task test races reach Postgres on two sessions at once.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { lockSiblings } from '../../packages/core-records/src/tasks/placement.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { advisoryLock, connect } from '../../packages/core-records/src/tenancy/database.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { c57bWorld, type C57bWorld } from './c57b-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('a change-request task after its waits', () => {
  let w: C57bWorld;
  beforeAll(async () => {
    w = await c57bWorld('c57bwait');
  }, 240_000);
  afterAll(async () => {
    await w?.world.db.drop();
  });

  it('two calls at once reach two database sessions', async () => {
    const concurrent = await c57bWorld('c57bcon');
    const blockingDb = connect(concurrent.world.db.appUrl);
    let unlock!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<number>((r) => {
      ready = r;
    });
    const released = new Promise<void>((r) => {
      unlock = r;
    });
    let pending: Promise<unknown> | undefined;
    let blocker: Promise<void> | undefined;
    try {
      const id = await concurrent.filed('approve');
      const lease = await concurrent.leaseOn();
      blocker = blockingDb.withBusiness(concurrent.world.business, async (tx) => {
        await tx.query('select id from public.review_change_requests where id = $1 for update', [
          id,
        ]);
        const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
        ready(row!.pid);
        await released;
      });
      const pid = await held;
      // Exactly the calls in the added concurrency test; the request lock makes overlap observable.
      pending = Promise.all([concurrent.make(lease, id), concurrent.make(lease, id)]);
      let waiting = 0;
      for (let i = 0; i < 100; i++) {
        // The sessions waiting behind the blocker, directly or through another waiter: Postgres
        // queues a second waiter on a row behind the first (a `tuple` lock), so it names the
        // first call, not the blocker, among its blocking pids.
        const [row] = await concurrent.world.db.admin.execute<{ n: number }>(
          `with recursive waiter(pid) as (
             select pid from pg_stat_activity
              where datname = current_database() and $1::int = any(pg_blocking_pids(pid))
             union
             select a.pid from pg_stat_activity a join waiter on waiter.pid = any(pg_blocking_pids(a.pid))
              where a.datname = current_database()
           )
           select count(*)::int as n from waiter`,
          [pid],
        );
        waiting = row!.n;
        if (waiting >= 2) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting, 'both calls must enter Postgres before either can finish').toBe(2);
    } finally {
      unlock?.();
      await blocker;
      await pending;
      await blockingDb.close();
      await concurrent.world.db.drop();
    }
  }, 30_000);

  it('a lease that runs out during task placement makes no task and leaves the request pending', async () => {
    const id = await w.filed('approve');
    const [task] = await w.world.db.admin.execute<{ revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [w.taskA],
    );
    const proposed = detailOf(
      await w.as(w.ava, {
        command: 'task.propose',
        recordId: w.taskA,
        expectedRevision: Number(task!.revision),
        purpose: `sol_${randomUUID().slice(0, 8)}`,
        maximumMinor: 3000,
        currency: 'AUD',
        payload: { instruction: 'make the approved request a task' },
        step: { kind: 'compose', payload: {} },
      }),
    );
    const decided = detailOf(
      await w.as(w.ava, {
        command: 'task.decide',
        gateId: proposed['gateId'],
        versionId: proposed['versionId'],
        decision: 'approve',
        note: 'approved for the proof',
      }),
    );
    const picked = detailOf(
      await w.as(w.ava, { command: 'task.pickup', reservationId: decided['reservationId'] }),
    );
    const lease = { leaseId: String(picked['leaseId']), fence: Number(picked['fence']) };
    expect(lease.leaseId).not.toBe('undefined');
    const make = () =>
      w.as(w.ava, { command: 'review.make_change_task', ...lease, changeRequestId: id });
    const before = await w.tasks(w.world.business);
    let unlock!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<number>((r) => {
      ready = r;
    });
    const released = new Promise<void>((r) => {
      unlock = r;
    });
    const blockingDb = connect(w.world.db.appUrl);
    const blocker = blockingDb.withBusiness(w.world.business, async (tx) => {
      await lockSiblings(tx, w.taskA, null);
      const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      ready(row!.pid);
      await released;
    });
    const pid = await held;
    let pending: ReturnType<typeof make> | undefined;
    try {
      await w.world.db.admin.execute(
        `update public.leases
        set expires_at = clock_timestamp() + interval '4 seconds' where id = $1`,
        [lease.leaseId],
      );
      pending = make();
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const [row] = await w.world.db.admin.execute<{ waiting: boolean }>(
          `select exists(select 1 from pg_stat_activity
            where datname = current_database() and $1::int = any(pg_blocking_pids(pid))) as waiting`,
          [pid],
        );
        if (row?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting, 'the command reached the sibling lock after its lease check').toBe(true);
      await w.world.db.admin.execute(
        `select pg_sleep(greatest(0,
        extract(epoch from expires_at - clock_timestamp())) + 0.1)
        from public.leases where id = $1`,
        [lease.leaseId],
      );
    } finally {
      unlock();
      await blocker;
      await blockingDb.close();
    }
    const answer = await pending!;
    const after = await w.tasks(w.world.business);
    const linked = (await w.requests(w.world.business)).find((r) => r.id === id)?.created_task_id;
    expect(
      { refused: isCommandRefusal(answer), taskCount: after, linked },
      'an expired lease must not create a task or consume the approved request',
    ).toEqual({ refused: true, taskCount: before, linked: null });
  }, 30_000);

  it('a lease that runs out during the audit-chain wait makes no task and leaves the request pending', async () => {
    const w = await c57bWorld('sol2143audit');
    const blockingDb = connect(w.world.db.appUrl);
    let release!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blocker: Promise<void> | undefined;
    let pending: ReturnType<typeof w.as> | undefined;
    try {
      const id = await w.filed('approve');
      const [task] = await w.world.db.admin.execute<{ revision: string }>(
        'select revision::text as revision from public.records where id = $1',
        [w.taskA],
      );
      const proposed = detailOf(
        await w.as(w.ava, {
          command: 'task.propose',
          recordId: w.taskA,
          expectedRevision: Number(task!.revision),
          purpose: `sol_${randomUUID().slice(0, 8)}`,
          maximumMinor: 3000,
          currency: 'AUD',
          payload: { instruction: 'make the approved request a task' },
          step: { kind: 'compose', payload: {} },
        }),
      );
      const decided = detailOf(
        await w.as(w.ava, {
          command: 'task.decide',
          gateId: proposed['gateId'],
          versionId: proposed['versionId'],
          decision: 'approve',
          note: 'approved for the proof',
        }),
      );
      const picked = detailOf(
        await w.as(w.ava, {
          command: 'task.pickup',
          reservationId: decided['reservationId'],
        }),
      );
      const lease = { leaseId: String(picked['leaseId']), fence: Number(picked['fence']) };
      expect(lease.leaseId).not.toBe('undefined');
      const before = await w.tasks(w.world.business);
      await w.world.db.admin.execute(
        `update public.leases set expires_at = clock_timestamp() + interval '4 seconds' where id = $1`,
        [lease.leaseId],
      );
      blocker = blockingDb.withBusiness(w.world.business, async (tx) => {
        await advisoryLock(tx, w.world.business.toLowerCase());
        const [row] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
        ready(row!.pid);
        await released;
      });
      const pid = await held;
      pending = w.as(w.ava, { command: 'review.make_change_task', ...lease, changeRequestId: id });
      let waiting = false;
      for (let i = 0; i < 200; i++) {
        const [row] = await w.world.db.admin.execute<{ waiting: boolean }>(
          `select exists(select 1 from pg_stat_activity where datname = current_database()
            and $1::int = any(pg_blocking_pids(pid))) as waiting`,
          [pid],
        );
        if (row?.waiting) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting, 'the command must reach the audit-chain lock').toBe(true);
      await w.world.db.admin.execute(
        `select pg_sleep(greatest(0, extract(epoch from expires_at - clock_timestamp())) + 0.1)
         from public.leases where id = $1`,
        [lease.leaseId],
      );
      release();
      await blocker;
      const answer = await pending;
      const linked = (await w.requests(w.world.business)).find(
        (row) => row.id === id,
      )?.created_task_id;
      expect({
        refused: isCommandRefusal(answer),
        tasks: await w.tasks(w.world.business),
        linked,
      }).toEqual({ refused: true, tasks: before, linked: null });
    } finally {
      release?.();
      await blocker;
      await pending;
      await blockingDb.close();
      await w.world.db.drop();
    }
  }, 240_000);
});
