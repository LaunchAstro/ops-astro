// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol 6 RUNTIME-1 at 158d6de, through the command entry.
//
// `now()` is the transaction's start. A handback or a pickup that began before
// a lease's expiry and waited on the cap lock until after it must judge the
// lease on the clock read once its locks are held. The handback is refused
// `LEASE_EXPIRED` and only retains its report; the pickup fences and
// classifies the expired claim and opens exactly one fresh hold. Each schedule
// parks the command on the cap row held by another connection, waits until the
// database clock is past the expiry, and only then lets go. The lease is
// never back-dated past its expiry; nothing sleeps longer than its three seconds.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { handbackFootprint, retainedCodes, successorBody } from './handback-footprint.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  awaitParked,
  codeOf,
  handbackBody,
  holdRows,
  liveWork,
  openSchedules,
  racer,
  rows,
  startedBefore,
  type Schedules,
  waitPast,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/lease-expiry-post-lock-clock: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const leaseExpiry = `select expires_at from public.leases where id = $1`;

/** Three seconds left on the lease and its delegation, on the database clock. */
async function expireSoon(s: Schedules, leaseId: unknown): Promise<void> {
  await s.db.admin.execute(
    `with lease as (
       update public.leases set expires_at = clock_timestamp() + interval '3 seconds'
        where business_id = $1 and id = $2
        returning delegation_id, expires_at)
     update public.delegations d set expires_at = lease.expires_at
       from lease where d.business_id = $1 and d.id = lease.delegation_id`,
    [s.business, leaseId],
  );
}

describe.skipIf(serverUrl === undefined)(
  'RUNTIME-1: lease expiry is judged after the lock wait',
  () => {
    let s: Schedules;

    beforeAll(async () => {
      s = await openSchedules('s6lex', 100_000);
    }, 90_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it('refuses LEASE_EXPIRED to a handback that waited on the cap past its lease expiry', async () => {
      const { picked } = await liveWork(s, 'handed back across its expiry', 1_000);
      await expireSoon(s, picked['leaseId']);
      const before = await handbackFootprint(s, picked['leaseId']);

      const handerDb = racer(s);
      const holder = await holdRows(s, 'budget_caps', [s.capId]);
      let answer;
      try {
        const handing = asAgent(
          s,
          handbackBody(picked, successorBody(100)),
          String(picked['credential']),
          handerDb,
        );
        await awaitParked(s, 'budget_caps', 1);
        expect(await startedBefore(s, leaseExpiry, picked['leaseId'])).toBe(true);
        await waitPast(s, leaseExpiry, picked['leaseId']);
        await holder.release();
        answer = await handing;
      } finally {
        await holder.release().catch(() => undefined);
        await handerDb.close();
      }

      expect(codeOf(answer)).toBe('LEASE_EXPIRED');
      // The report is retained and nothing else moved: no settlement, the lease
      // and its hold as they were, and no successor version or gate.
      expect(await retainedCodes(s, picked['leaseId'])).toStrictEqual(['LEASE_EXPIRED']);
      expect(await handbackFootprint(s, picked['leaseId'])).toStrictEqual(before);
    }, 30_000);

    it('fences an expired claim for a pickup that waited on the cap past its expiry', async () => {
      const { proposal, decision, picked } = await liveWork(
        s,
        'picked up across its expiry',
        1_000,
      );
      await expireSoon(s, picked['leaseId']);
      const oldReservation = String(decision['reservationId']);

      const pickerDb = racer(s);
      const holder = await holdRows(s, 'budget_caps', [s.capId]);
      let answer;
      try {
        const picking = asPerson(
          s,
          {
            command: 'task.pickup',
            operationId: randomUUID(),
            reservationId: oldReservation,
            leaseSeconds: 600,
          },
          pickerDb,
        );
        await awaitParked(s, 'budget_caps', 1);
        expect(await startedBefore(s, leaseExpiry, picked['leaseId'])).toBe(true);
        await waitPast(s, leaseExpiry, picked['leaseId']);
        await holder.release();
        answer = await picking;
      } finally {
        await holder.release().catch(() => undefined);
        await pickerDb.close();
      }

      const replaced = appliedDetail(answer, 'task.pickup across the expiry');
      expect(replaced['reservationId']).not.toBe(oldReservation);
      expect(replaced['fence']).toBe(Number(picked['fence']) + 1);

      // The expired claim is fenced and its hold classified, never revived.
      const leases = await rows<{
        readonly id: string;
        readonly state: string;
        readonly beyond: boolean;
      }>(
        s,
        `select l.id, l.state,
              (l.expires_at >= old.expires_at + interval '600 seconds') as beyond
         from public.leases l, public.leases old
        where l.business_id = $1 and l.task_id = old.task_id and old.id = $2
        order by l.fence`,
        [s.business, picked['leaseId']],
      );
      expect(leases.map((row) => [row.id, row.state])).toStrictEqual([
        [picked['leaseId'], 'expired'],
        [replaced['leaseId'], 'live'],
      ]);
      // The new lease runs from the instant read after the wait, which is past
      // the old expiry, not from the transaction's start before it.
      expect(leases[1]?.beyond).toBe(true);

      // Exactly one fresh hold on the version, and one hold's worth of money.
      const holds = await rows<{
        readonly id: string;
        readonly state: string;
        readonly cause: string | null;
      }>(
        s,
        `select id, state, classified_cause as cause from public.reservations
        where business_id = $1 and version_id = $2 order by created_at`,
        [s.business, proposal['versionId']],
      );
      expect(holds).toEqual([
        { id: oldReservation, state: 'abandoned', cause: 'lease_expired_and_fenced' },
        { id: replaced['reservationId'], state: 'held', cause: null },
      ]);
      const envelope = await rows<{ readonly held: string }>(
        s,
        `select e.held_minor::text as held from public.task_envelopes e
         join public.reservations r on r.business_id = e.business_id and r.envelope_id = e.id
        where r.business_id = $1 and r.id = $2`,
        [s.business, oldReservation],
      );
      expect(envelope).toEqual([{ held: '1000' }]);
    }, 30_000);

    it('lets the same agent replace its own claim after waiting on the cap past its expiry', async () => {
      const { decision, picked } = await liveWork(
        s,
        'replaced by its agent across its expiry',
        1_000,
      );
      await expireSoon(s, picked['leaseId']);
      const oldReservation = String(decision['reservationId']);

      const pickerDb = racer(s);
      const holder = await holdRows(s, 'budget_caps', [s.capId]);
      let answer;
      try {
        const picking = asAgent(
          s,
          {
            command: 'task.pickup',
            operationId: randomUUID(),
            reservationId: oldReservation,
            leaseSeconds: 600,
          },
          undefined,
          pickerDb,
        );
        await awaitParked(s, 'budget_caps', 1);
        expect(await startedBefore(s, leaseExpiry, picked['leaseId'])).toBe(true);
        await waitPast(s, leaseExpiry, picked['leaseId']);
        await holder.release();
        answer = await picking;
      } finally {
        await holder.release().catch(() => undefined);
        await pickerDb.close();
      }

      // The agent's own delegation for this purpose expired with its lease, so
      // the mint settles it rather than refusing DELEGATION_ALREADY_LIVE.
      const replaced = appliedDetail(answer, 'agent task.pickup across the expiry');
      expect(replaced['reservationId']).not.toBe(oldReservation);
      expect(replaced['fence']).toBe(Number(picked['fence']) + 1);
      const delegations = await rows<{
        readonly lease: string;
        readonly settled: boolean;
        readonly matches: boolean;
      }>(
        s,
        `select l.id as lease, (d.settled_at is not null) as settled,
                (d.expires_at = l.expires_at) as matches
           from public.leases l
           join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
          where l.business_id = $1 and l.id in ($2, $3)
          order by l.fence`,
        [s.business, picked['leaseId'], replaced['leaseId']],
      );
      expect(delegations.map((row) => [row.lease, row.settled, row.matches])).toStrictEqual([
        [picked['leaseId'], true, true],
        [replaced['leaseId'], false, true],
      ]);
      const held = await rows<{ readonly n: string }>(
        s,
        `select count(*)::text as n from public.reservations r
           join public.reservations old on old.business_id = r.business_id
                                        and old.version_id = r.version_id
          where r.business_id = $1 and old.id = $2 and r.state = 'held'`,
        [s.business, oldReservation],
      );
      expect(held[0]?.n).toBe('1');
    }, 30_000);
  },
);
