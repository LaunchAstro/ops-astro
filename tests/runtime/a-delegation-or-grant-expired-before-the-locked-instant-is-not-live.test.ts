// SPDX-License-Identifier: AGPL-3.0-only
//
// The locked instant is the database's clock read after the locks, to the
// microsecond, and every runtime site passes it back as text. A delegation a
// lease works under, and a grant asked at that instant, whose expiry falls in
// the same millisecond before it, are no longer live: the instant is compared
// as the database holds it, never rounded down on its way through the driver.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { checkAuthorityAt } from '../../packages/core-runtime/src/index.ts';
import { readLease } from '../../packages/core-runtime/src/lease-ownership.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol } from '../commands/fixture.ts';
import { liveWork, openSchedules, type Schedules } from './schedules-harness.ts';

/**
 * A grant ending at `.123400` within some millisecond an hour on, asked about
 * at `.123399` and at `.123456` of it: live as the statement runs, so only the
 * instant judges it.
 */
async function grantJudgedAround(s: Schedules) {
  const person = await enrol(s.db.app, s.business, `micro_${randomUUID().slice(0, 8)}`);
  const ends = new Date(Date.now() + 3_600_000);
  ends.setUTCMilliseconds(123);
  const at = (micros: string): string =>
    ends.toISOString().replace('T', ' ').replace('.123Z', `.${micros}+00`);
  const scope = { kind: 'record', id: randomUUID() } as const;
  const asked = { collection: 'task', action: 'read', scope } as const;
  const subjects = [{ kind: 'person', id: person.personId }] as const;
  return await s.db.app.withBusiness(s.business, async (tx) => {
    const grant = await issueGrant(tx, [], {
      subject: subjects[0],
      scope,
      collection: 'task',
      action: 'read',
      parentGrantId: null,
      grantedByActorId: person.actorId,
    });
    if (!grant.ok) throw new Error(grant.refusal.code);
    await tx.query(`update public.grants set expires_at = $2::text::timestamptz where id = $1`, [
      grant.value,
      at('123400'),
    ]);
    const before = await checkAuthorityAt(tx, subjects, asked, at('123399'));
    const after = await checkAuthorityAt(tx, subjects, asked, at('123456'));
    return { before: before.ok, after: after.ok };
  });
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)('the locked instant', () => {
  let s: Schedules;
  beforeAll(async () => {
    s = await openSchedules('lockedmicros_auth', 1_000_000);
  }, 180_000);
  afterAll(async () => {
    await s?.db.drop();
  });

  it("a lease's delegation that expired earlier in the locked instant's millisecond reads not live", async () => {
    const work = await liveWork(s, 'A delegation expiring within a millisecond', 1_000);
    const leaseId = String(work.picked['leaseId']);
    // An hour after it was granted, at .123400 of its second; read 56 microseconds on.
    const [ends] = await s.db.admin.execute<{ at: string }>(
      `update public.delegations d
          set expires_at = date_trunc('second', d.granted_at) + interval '1 hour 0.1234 seconds'
         from public.leases l where l.id = $1 and d.id = l.delegation_id
       returning (d.expires_at + interval '56 microseconds')::text as at`,
      [leaseId],
    );
    const lease = await s.db.app.withBusiness(
      s.business,
      async (tx) => await readLease(tx, leaseId, ends?.at ?? ''),
    );
    expect(lease?.delegation_live).toBe(false);
  });

  it("a grant that expired earlier in the locked instant's millisecond covers nothing", async () => {
    expect(await grantJudgedAround(s)).toEqual({ before: true, after: false });
  });
});
