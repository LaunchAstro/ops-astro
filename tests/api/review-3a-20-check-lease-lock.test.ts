// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-3A-20: MP-6-1's "a check and a handback on one lease at once
// serialise on the lease lock" asserts only that the check row count matches
// the check's status. Without the lease lock in `recordCheck` that still
// holds: a check that read the lease live before the handback committed
// inserts its row anyway (its foreign key waits on the handback's lock, then
// passes), answers 200 and counts 1.
//
// This suite fixes the interleaving instead of racing for it. A transaction
// holds the lease row `for update`, as the handback's `acquire` does, while
// the check arrives; under that lock it ends the lease the way the handback's
// `endLease` does, and commits. A check serialised on the lease lock re-reads
// the lease after the wait, finds it no longer live and writes nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Controls } from './controls-fixture.ts';
import { CHECK_ROWS, checksWorld, pickedUpOn } from './mp-6-1-checks-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const waitingOnLocks = `select count(*)::text as n from pg_stat_activity
   where datname = current_database() and wait_event_type = 'Lock'`;

describe.skipIf(serverUrl === undefined)('REVIEW-3A-20 check serialised on the lease lock', () => {
  let c: Controls;

  beforeAll(async () => {
    ({ c } = await checksWorld('rv3a20_checks'));
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  it('REVIEW-3A-20: a check that waited on the lease lock behind a handback ending the lease is refused and writes nothing', async () => {
    const work = await pickedUpOn(c, 'held_lease');
    let checking: ReturnType<Controls['asAgent']> | undefined;
    let settledUnderLock = false;
    await c.fixture.db.admin.transaction(async (execute) => {
      // The handback's first step on the lease: its row lock (`acquire`).
      await execute(`select 1 from public.leases where business_id = $1 and id = $2 for update`, [
        c.fixture.business,
        work.leaseId,
      ]);
      checking = c.asAgent(
        'task.check',
        { leaseId: work.leaseId, fence: work.fence, name: 'behind the handback', outcome: 'passed' },
        work.credential,
      );
      const settle = (): void => {
        settledUnderLock = true;
      };
      void checking.then(settle, settle);
      // The check reaches the lease and waits on the lock this transaction holds.
      const deadline = Date.now() + 15_000;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- polling until the check waits
        const [row] = await execute<{ readonly n: string }>(waitingOnLocks, []);
        if (Number(row?.n) >= 1 || Date.now() > deadline) break;
        // eslint-disable-next-line no-await-in-loop -- as above
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      expect(settledUnderLock, 'the check answered while the lease lock was held').toBe(false);
      // The handback's end of the lease, under its lock (`endLease`).
      await execute(
        `update public.leases set state = 'released', released_at = now()
          where business_id = $1 and id = $2 and state = 'live'`,
        [c.fixture.business, work.leaseId],
      );
    });
    if (checking === undefined) throw new Error('the check was never sent');
    const checked = await checking;
    expect(checked.status, JSON.stringify(checked.body)).toBe(410);
    expect(checked.body['code'], JSON.stringify(checked.body)).toBe('LEASE_EXPIRED');
    expect(await c.count(CHECK_ROWS, [work.taskId])).toBe(0);
  }, 60_000);
});
