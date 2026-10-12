// SPDX-License-Identifier: AGPL-3.0-only
//
// The locked instant is the database's clock read after the locks, to the
// microsecond. A lease whose expiry falls within the same millisecond, before
// that instant, has expired: the instant is compared as the database holds
// it, never rounded down to the millisecond on its way through the driver.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLease } from '../../packages/core-runtime/src/lease-ownership.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { liveWork, openSchedules, type Schedules } from './schedules-harness.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)('the locked instant', () => {
  let s: Schedules;
  beforeAll(async () => {
    s = await openSchedules('lockedmicros', 1_000_000);
  }, 180_000);
  afterAll(async () => {
    await s?.db.drop();
  });

  it('a lease that expired earlier in the same millisecond as the locked instant reads expired', async () => {
    const work = await liveWork(s, 'A lease expiring within a millisecond', 1_000);
    const leaseId = String(work.picked['leaseId']);
    await s.db.admin.execute(
      `update public.leases set expires_at = '2026-10-12 07:20:00.123400+00' where id = $1`,
      [leaseId],
    );
    const lease = await s.db.app.withBusiness(
      s.business,
      async (tx) => await readLease(tx, leaseId, '2026-10-12 07:20:00.123456+00'),
    );
    expect(lease?.expired).toBe(true);
  });
});
