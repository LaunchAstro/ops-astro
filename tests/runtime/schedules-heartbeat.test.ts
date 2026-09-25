// SPDX-License-Identifier: AGPL-3.0-only
//
// The heartbeat's eight-hour total, at and just past the boundary.
//
// `heartbeat.ts` renews to `greatest(expires_at, least(now() + renewal,
// acquired_at + 8 hours))`, in SQL and on the database clock. The boundary is
// the existing lane constant `MAXIMUM_LEASE_LIFETIME_SECONDS`; this case
// invents no policy, it only executes the one that is there. `controls-work.test.ts`
// covers the per-beat limit at the command boundary and never reaches the
// total.
//
// Nobody waits eight hours. The lease's `acquired_at` is moved back on the
// database clock instead (`now() - interval ...`, by the owner connection), so
// the lease is exactly as old as the case says when the heartbeat's own
// transaction reads `now()`. The renewal itself goes through `task.heartbeat`
// on the agent's entry, with the credential its pickup issued.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { MAXIMUM_LEASE_LIFETIME_SECONDS } from '../../packages/core-runtime/src/index.ts';
import {
  asAgent,
  codeOf,
  liveWork,
  openSchedules,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/schedules-heartbeat: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** The renewal each beat asks for: the command boundary's own maximum. */
const RENEWAL = 3_600;

interface LeaseTimes {
  readonly atBoundary: boolean;
  readonly beyondBoundary: boolean;
  readonly expiresAt: string;
  readonly delegationMatches: boolean;
}

describe.skipIf(serverUrl === undefined)(
  'heartbeat: the eight-hour total on the database clock',
  () => {
    let s: Schedules;

    beforeAll(async () => {
      s = await openSchedules('hb', 100_000);
    }, 90_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it('is the existing eight-hour constant', () => {
      expect(MAXIMUM_LEASE_LIFETIME_SECONDS).toBe(8 * 60 * 60);
    });

    /** Age the lease on the database clock: acquired `ageSeconds` ago. */
    async function age(
      picked: Detail,
      ageSeconds: number,
      expiresInSeconds?: number,
    ): Promise<void> {
      await s.db.admin.execute(
        `update public.leases
          set acquired_at = now() - make_interval(secs => $3),
              expires_at = coalesce(now() + make_interval(secs => $4), expires_at)
        where business_id = $1 and id = $2`,
        [s.business, picked['leaseId'], ageSeconds, expiresInSeconds ?? null],
      );
    }

    async function times(picked: Detail): Promise<LeaseTimes> {
      const found = await rows<{
        readonly at_boundary: boolean;
        readonly beyond_boundary: boolean;
        readonly expires_at: string;
        readonly delegation_matches: boolean;
      }>(
        s,
        `select l.expires_at = l.acquired_at + make_interval(secs => $3) as at_boundary,
              l.expires_at > l.acquired_at + make_interval(secs => $3) as beyond_boundary,
              l.expires_at::text as expires_at,
              d.expires_at = l.expires_at as delegation_matches
         from public.leases l
         join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
        where l.business_id = $1 and l.id = $2`,
        [s.business, picked['leaseId'], MAXIMUM_LEASE_LIFETIME_SECONDS],
      );
      const row = found[0];
      if (row === undefined) throw new Error('no lease');
      return {
        atBoundary: row.at_boundary,
        beyondBoundary: row.beyond_boundary,
        expiresAt: row.expires_at,
        delegationMatches: row.delegation_matches,
      };
    }

    async function beat(picked: Detail): ReturnType<typeof asAgent> {
      return await asAgent(
        s,
        {
          command: 'task.heartbeat',
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          leaseSeconds: RENEWAL,
        },
        String(picked['credential']),
      );
    }

    it('at the limit: a renewal that would pass eight hours stops exactly on it', async () => {
      const { picked } = await liveWork(s, 'renewed onto the boundary', 1_000);
      // Thirty minutes of total left, and the beat asks for sixty.
      await age(picked, MAXIMUM_LEASE_LIFETIME_SECONDS - 1_800);
      const answer = await beat(picked);
      expect(codeOf(answer)).toBe('applied');
      const after = await times(picked);
      expect(after.atBoundary).toBe(true);
      expect(after.beyondBoundary).toBe(false);
      expect(after.delegationMatches).toBe(true);

      // A second beat at the boundary changes nothing: there is no total left.
      expect(codeOf(await beat(picked))).toBe('applied');
      expect(await times(picked)).toStrictEqual(after);
    });

    it('just past the limit: a live lease older than eight hours is not extended', async () => {
      const { picked } = await liveWork(s, 'past the boundary, still live', 1_000);
      // One second past the total, with ten minutes still on the current expiry.
      await age(picked, MAXIMUM_LEASE_LIFETIME_SECONDS + 1, 600);
      const before = await times(picked);
      expect(before.beyondBoundary).toBe(true);

      const answer = await beat(picked);
      expect(codeOf(answer)).toBe('applied');
      const after = await times(picked);
      // `greatest(expires_at, ...)`: the renewal never shortens, and past the
      // total it never lengthens either.
      expect(after.expiresAt).toBe(before.expiresAt);
    });

    it('just past the limit and expired: the heartbeat refuses and revives nothing', async () => {
      const { picked } = await liveWork(s, 'past the boundary, expired', 1_000);
      // Acquired eight hours and one second ago; expired one second ago, on the boundary.
      await age(picked, MAXIMUM_LEASE_LIFETIME_SECONDS + 1, -1);
      const before = await times(picked);

      const answer = await beat(picked);
      expect(['LEASE_EXPIRED', 'DELEGATION_NOT_LIVE']).toContain(codeOf(answer));
      expect(await times(picked)).toStrictEqual(before);
      const live = await rows<{ readonly live: boolean }>(
        s,
        `select expires_at > now() as live from public.leases where business_id = $1 and id = $2`,
        [s.business, picked['leaseId']],
      );
      expect(live[0]?.live).toBe(false);
    });
  },
);
