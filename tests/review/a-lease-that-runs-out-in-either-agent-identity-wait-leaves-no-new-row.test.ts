// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, no-await-in-loop -- one hold per wait, polled until it waits */
//
// C57 part B (#2117), S2143-5's row count: the agent path's identity waits come after the
// change-request task is written (the actor's and the login's `for share`, `agent-standing.ts`).
// A worker lease that runs out in either wait is judged under the work's savepoint after them, so
// the refusal leaves no new row in the business's records and no link on the request.

import { describe, expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c57bWorld } from './c57b-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const HOLDS = [
  {
    wait: 'the actor',
    hold: 'select id from public.actors where business_id = $1 and id = $2 for no key update',
    waits: '%from public.actors where%for share%',
  },
  {
    wait: 'the login',
    hold: `select actor_id from public.actor_logins
            where business_id = $1 and actor_id = $2 for no key update`,
    waits: '%from public.actor_logins%for share%',
  },
] as const;

describe.skipIf(serverUrl === undefined)('a change-request task after the identity waits', () => {
  for (const { wait, hold, waits } of HOLDS) {
    it(`a lease that runs out while ${wait} is held leaves no new row`, async () => {
      const w = await c57bWorld(wait === 'the actor' ? 'c57bnoact' : 'c57bnolog');
      const holder = connect(w.world.db.appUrl);
      let pending: ReturnType<typeof w.make> | undefined;
      const rows = async () =>
        (
          await w.world.db.admin.execute<{ n: number }>(
            'select count(*)::int as n from public.records where business_id = $1',
            [w.world.business],
          )
        )[0]!.n;
      try {
        const id = await w.filed('approve');
        const lease = await w.leaseOn();
        const [owned] = await w.world.db.admin.execute<{ holder_actor_id: string }>(
          'select holder_actor_id from public.leases where id = $1',
          [lease.leaseId],
        );
        const before = await rows();
        await holder.withBusiness(w.world.business, async (tx) => {
          await tx.query(hold, [tx.businessId, owned!.holder_actor_id]);
          const [blocker] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
          await w.world.db.admin.execute(
            "update public.leases set expires_at = clock_timestamp() + interval '3 seconds' where id = $1",
            [lease.leaseId],
          );
          pending = w.make(lease, id);
          let waited = false;
          for (let i = 0; i < 500 && !waited; i++) {
            const [row] = await w.world.db.admin.execute<{ waiting: boolean; expired: boolean }>(
              `select exists(select 1 from pg_stat_activity
                       where datname = current_database() and $1::int = any(pg_blocking_pids(pid))
                         and query like $3) as waiting,
                      (select expires_at <= clock_timestamp() from public.leases where id = $2) as expired`,
              [blocker!.pid, lease.leaseId, waits],
            );
            waited = row?.waiting === true && row.expired;
            if (!waited)
              await new Promise((resolve) => {
                setTimeout(resolve, 20);
              });
          }
          expect(waited, `the call waited on ${wait} until the lease ran out`).toBe(true);
        });
        const answer = await pending!;
        const linked = (await w.requests(w.world.business)).find((row) => row.id === id);
        expect({
          refused: isCommandRefusal(answer),
          newRows: (await rows()) - before,
          linked: linked?.created_task_id,
        }).toEqual({ refused: true, newRows: 0, linked: null });
      } finally {
        await pending?.catch(() => null);
        await holder.close();
        await w.world.db.drop();
      }
    }, 60_000);
  }
});
