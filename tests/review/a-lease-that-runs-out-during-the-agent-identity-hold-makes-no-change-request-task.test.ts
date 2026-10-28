// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, no-await-in-loop, no-promise-executor-return, unicorn/no-useless-undefined -- Sol's proof, copied */
//
// C57 part B (#2117), Sol's proof for S2143-5: a worker lease that runs out while the agent path
// waits on its identity hold (the actor's `for share`, after the handler) makes no task and
// leaves the request pending and unlinked.
import { describe, expect, it } from 'vitest';
import { c57bWorld } from './c57b-world.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a change-request task after the agent identity hold',
  () => {
    it('a lease that runs out during the agent identity hold makes no task and leaves the request pending', async () => {
      const w = await c57bWorld('sol2143last');
      const holder = connect(w.world.db.appUrl);
      let pending: ReturnType<typeof w.make> | undefined;
      try {
        const id = await w.filed('approve');
        const lease = await w.leaseOn();
        const [owned] = await w.world.db.admin.execute<{ holder_actor_id: string }>(
          'select holder_actor_id from public.leases where id = $1',
          [lease.leaseId],
        );
        const before = await w.tasks(w.world.business);
        await holder.withBusiness(w.world.business, async (tx) => {
          await tx.query(
            'select id from public.actors where business_id = $1 and id = $2 for no key update',
            [tx.businessId, owned!.holder_actor_id],
          );
          const [blocker] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
          await w.world.db.admin.execute(
            "update public.leases set expires_at = clock_timestamp() + interval '3 seconds' where id = $1",
            [lease.leaseId],
          );
          pending = w.make(lease, id);
          let waiting = false;
          for (let i = 0; i < 500; i++) {
            const [row] = await w.world.db.admin.execute<{ waiting: boolean; expired: boolean }>(
              `select exists(select 1 from pg_stat_activity where datname = current_database() and $1::int = any(pg_blocking_pids(pid)) and query like '%from public.actors%for share%') as waiting, (select expires_at <= clock_timestamp() from public.leases where id = $2) as expired`,
              [blocker!.pid, lease.leaseId],
            );
            if (row?.waiting && row.expired) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(waiting, 'the final agent identity hold waited until after lease expiry').toBe(
            true,
          );
        });
        const answer = await pending!;
        const linked = (await w.requests(w.world.business)).find(
          (row) => row.id === id,
        )?.created_task_id;
        expect({
          refused: isCommandRefusal(answer),
          tasks: await w.tasks(w.world.business),
          linked,
        }).toEqual({ refused: true, tasks: before, linked: null });
      } finally {
        await pending?.catch(() => undefined);
        await holder.close();
        await w.world.db.drop();
      }
    }, 60000);
  },
);
