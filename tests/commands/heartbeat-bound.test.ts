// SPDX-License-Identifier: AGPL-3.0-only
//
// L6 W02 (c): `task.heartbeat`'s maximum `leaseSeconds`, through the agent
// route.
//
// `renewLease` reads the operand through `readLeaseSeconds` with the route's
// maximum, `MAXIMUM_RENEWAL_SECONDS` (`tasks-lease.ts` `readLeaseSeconds`, `renewLease`).
// `controls-work.test.ts` refuses 100000; this pins the boundary itself. The
// maximum is accepted and renews to it; one second more is `FIELD_VALUE_INVALID`
// naming the operand, audited, and moves neither the lease nor its delegation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { MAXIMUM_RENEWAL_SECONDS } from '../../packages/core-runtime/src/heartbeat.ts';
import { createControls, detailOf, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the heartbeat maximum', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('hbbd');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  interface Claim {
    readonly leaseId: string;
    readonly fence: number;
    readonly credential: string;
  }

  async function claim(purpose: string): Promise<Claim> {
    const task = await c.createTask(`a lease renewed at the boundary (${purpose})`);
    const reservationId = await c.approve(await c.propose(task.id, task.revision, purpose));
    const picked = await c.pickup(reservationId, 60);
    return {
      leaseId: String(picked['leaseId']),
      fence: Number(picked['fence']),
      credential: String(picked['credential']),
    };
  }

  const leaseAndDelegation = async (leaseId: string): Promise<unknown> =>
    (
      await c.fixture.db.admin.execute(
        `select l.state, l.fence, l.expires_at as lease_expires, d.expires_at as delegation_expires
           from public.leases l join public.delegations d on d.id = l.delegation_id
          where l.id = $1`,
        [leaseId],
      )
    )[0];

  it('is the route maximum of one hour', () => {
    expect(MAXIMUM_RENEWAL_SECONDS).toBe(3_600);
  });

  it('accepts a renewal at the maximum, and renews to it', async () => {
    const lease = await claim('beat_at_max');
    const beat = await c.asAgent(
      'task.heartbeat',
      { leaseId: lease.leaseId, fence: lease.fence, leaseSeconds: MAXIMUM_RENEWAL_SECONDS },
      lease.credential,
    );
    expect(beat.status, JSON.stringify(beat.body)).toBe(200);
    expect(detailOf(beat)['leaseId']).toBe(lease.leaseId);
    expect(
      await c.count(
        `select count(*)::text as n from public.leases l
           join public.delegations d on d.id = l.delegation_id
          where l.id = $1 and l.state = 'live' and l.expires_at = d.expires_at
            and l.expires_at between now() + interval '3590 seconds' and now() + interval '3600 seconds'`,
        [lease.leaseId],
      ),
    ).toBe(1);
  });

  it('refuses one second over as FIELD_VALUE_INVALID, audited, and changes nothing', async () => {
    const lease = await claim('beat_over_max');
    const before = await leaseAndDelegation(lease.leaseId);
    const operationId = `heartbeat-over-${lease.leaseId}`;
    const beat = await c.asAgent(
      'task.heartbeat',
      {
        operationId,
        leaseId: lease.leaseId,
        fence: lease.fence,
        leaseSeconds: MAXIMUM_RENEWAL_SECONDS + 1,
      },
      lease.credential,
    );
    expect(beat.status).toBe(422);
    expect(beat.body['code']).toBe('FIELD_VALUE_INVALID');
    expect(beat.body['names']).toStrictEqual(['leaseSeconds']);
    expect(JSON.stringify(beat.body['fixes'])).toContain(String(MAXIMUM_RENEWAL_SECONDS));
    expect(await leaseAndDelegation(lease.leaseId)).toStrictEqual(before);
    expect(
      await c.count(
        `select count(*)::text as n from public.audit_events
          where command = 'task.heartbeat' and operation_id = $1`,
        [operationId],
      ),
    ).toBe(1);
    expect(
      await c.count(
        `select count(*)::text as n from public.audit_events
          where command = 'task.heartbeat' and operation_id = $1 and outcome = 'refused'
            and refusal_code = 'FIELD_VALUE_INVALID'`,
        [operationId],
      ),
    ).toBe(1);
  });
});
