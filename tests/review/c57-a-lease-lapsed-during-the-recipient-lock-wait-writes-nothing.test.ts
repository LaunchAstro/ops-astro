// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop, no-promise-executor-return, max-lines-per-function, unicorn/no-useless-undefined -- Sol's proof kept whole: it polls the database until the inbox insert waits */
//
// C57 (#2017): a run's lease that expires while the inbox insert waits on a recipient's row
// writes nothing (Sol's PR #2160 proof, kept whole).

import { describe, expect, it } from 'vitest';
import {
  footprint,
  noDatabase,
  on,
  ownPool,
  runOf,
  scene,
  shepherd,
  useShepherdWorld,
  w,
} from './shepherd-world.ts';

useShepherdWorld('sol2160recipient');
describe.skipIf(noDatabase)('C57 recipient lock', () => {
  it('C57 a lease expired during the recipient foreign-key wait writes nothing', async () => {
    const s = await scene();
    const run = await runOf();
    const before = await footprint();
    const holder = ownPool();
    const worker = ownPool();
    let pending: ReturnType<typeof shepherd> | undefined;
    try {
      await holder.withBusiness(on('alpha').business, async (tx) => {
        await tx.query(
          'select id from public.people where business_id = $1 and id = $2 for update',
          [tx.businessId, s.recipient.personId],
        );
        await w.db.admin.execute(
          "update public.leases set expires_at = clock_timestamp() + interval '3 seconds' where id = $1",
          [run.lease.leaseId],
        );
        pending = shepherd(run, s.review, { database: worker });
        const deadline = Date.now() + 10000;
        let observed = false;
        while (Date.now() < deadline) {
          const [row] = await w.db.admin.execute<{ waiting: boolean; expired: boolean }>(
            `select exists (select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%insert into public.inbox_items%') as waiting,
            (select expires_at <= clock_timestamp() from public.leases where id = $1) as expired`,
            [run.lease.leaseId],
          );
          if (row?.waiting && row.expired) {
            observed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(observed, 'the inbox insert waited on the recipient until the lease expired').toBe(
          true,
        );
      });
      expect({ answer: await pending, after: await footprint() }).toStrictEqual({
        answer: { kind: 'refused', code: 'LEASE_NOT_OWNED' },
        after: before,
      });
    } finally {
      await pending?.catch(() => undefined);
      await worker.close();
      await holder.close();
    }
  });
});
