// SPDX-License-Identifier: AGPL-3.0-only
//
// `take_lease` against writers on other connections. It reads the reservation,
// the gate, the claimant's grants and the task's highest fence, then inserts a
// lease at that fence plus one; the only waits are inside the insert (the
// one-live-lease and fence indexes, and its foreign keys). Each schedule here
// is forced and observed: a competing claim is held open on its own
// connection, the claim under test is seen parked behind it in
// `pg_stat_activity`, the change under test commits on a third connection, and
// only then does the competitor end. A crash or a lost response is a relay cut
// before or after the commit.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  mintDelegation,
  revokeDelegation,
} from '../../packages/core-records/src/authority/delegations.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { cutTransaction } from '../support/cut-transaction.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  openSchedules,
  racer,
  reasonOf,
  settle,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { approvedWork } from './lease-guard-support.ts';

const serverUrl = databaseUrlFromEnvironment();
const TAKE = `select public.take_lease($1, $2, $3, $4, $5, $6, $7)::int as fence`;

/** Whole seconds, so every claim names one instant. */
const inTenMinutes = (): Date => new Date(Math.floor(Date.now() / 1000) * 1000 + 600_000);

// eslint-disable-next-line max-lines-per-function -- one world, its schedules
describe.skipIf(serverUrl === undefined)('a lease claim against concurrent writers', () => {
  let s: Schedules;
  let colleague: Member;

  /** A person with business-wide write on tasks; answers them and that grant. */
  const writer = async (name: string): Promise<{ member: Member; grant: string }> => {
    const member = await enrol(s.db.app, s.business, name);
    const grant = await s.db.app.withBusiness(
      s.business,
      async (tx) => await grantTo(tx, member, 'write'),
    );
    return { member, grant };
  };

  beforeAll(async () => {
    s = await openSchedules('lease_race', 1_000_000);
    colleague = (await writer('colleague')).member;
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  /** One person's own claim on `reservation`, under the decider's approval. */
  const claim = (reservation: unknown, holder: string, lease = randomUUID()) => [
    lease,
    reservation,
    null,
    holder,
    s.decider.personId,
    inTenMinutes(),
    'task',
  ];

  const take = async (tx: TenantQuery, parameters: readonly unknown[]): Promise<number> => {
    const [row] = await tx.query<{ readonly fence: number }>(TAKE, parameters);
    return Number(row?.fence);
  };

  const leasesOn = async (taskId: unknown) =>
    await s.db.admin
      .execute<{ readonly holder: string; readonly fence: number }>(
        `select holder_actor_id::text as holder, fence::int as fence from public.leases
        where task_id = $1 order by fence`,
        [taskId],
      )
      .then((found) => found.map((row) => ({ holder: row.holder, fence: row.fence })));

  /**
   * The decider's claim on `reservation` is held open on its own connection;
   * the claim `second` names (the same reservation) is seen parked behind it;
   * `meanwhile` commits on a third connection; the decider's claim then ends
   * `ending`.
   */
  async function claimBehindCompetitor(
    reservation: unknown,
    second: readonly unknown[],
    ending: 'commit' | 'rollback',
    meanwhile: () => Promise<unknown> = async () => await Promise.resolve(),
  ): Promise<PromiseSettledResult<number>> {
    const competitor = await hold(
      s.db.appUrl,
      s.business,
      async (tx) => await take(tx, claim(reservation, s.decider.actorId)),
      ending,
    );
    const database = racer(s);
    try {
      // Settled as it starts, so its refusal is never an unhandled rejection.
      const claiming = settle([
        database.withBusiness(s.business, async (tx) => await take(tx, second)),
      ]);
      await waitingOn(s.db.admin, 'transactionid', 'take_lease');
      await meanwhile();
      await competitor.letGo();
      const [settled] = await claiming;
      return settled as PromiseSettledResult<number>;
    } finally {
      await competitor.letGo().catch(() => null);
      await database.close();
    }
  }

  /** The colleague's own claim on the reservation the decider also claims. */
  const behind = async (
    work: Detail,
    ending: 'commit' | 'rollback',
    meanwhile?: () => Promise<unknown>,
    claimant: Member = colleague,
  ) =>
    await claimBehindCompetitor(
      work['reservationId'],
      claim(work['reservationId'], claimant.actorId),
      ending,
      meanwhile,
    );

  /** A delegation for the agent on `taskId`, from the approving person, ending at `expires`. */
  const delegation = async (taskId: unknown, expires: Date): Promise<string> =>
    await s.db.app.withBusiness(s.business, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: s.agentActorId,
        delegatePersonId: s.decider.personId,
        mintedByActorId: s.decider.actorId,
        purpose: `lease_race_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        purposeScope: { kind: 'record', id: String(taskId) },
        expiresAt: expires,
      });
      if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
      return minted.value.delegation.id;
    });

  it('two claims on one reservation at once leave one lease, at the first fence', async () => {
    const work = await approvedWork(s);
    const second = await behind(work, 'commit');
    expect(reasonOf(second)).toMatch(/^23505 /u);
    expect(await leasesOn(work['taskId'])).toStrictEqual([{ holder: s.decider.actorId, fence: 1 }]);
  });

  it('a claim behind a competitor that rolled back takes the first fence itself', async () => {
    const work = await approvedWork(s);
    const second = await behind(work, 'rollback');
    expect(second).toStrictEqual({ status: 'fulfilled', value: 1 });
    expect(await leasesOn(work['taskId'])).toStrictEqual([{ holder: colleague.actorId, fence: 1 }]);
  });

  it('a claim whose write grant is revoked while it waits is refused', async () => {
    const work = await approvedWork(s);
    const revoked = await writer('revoked-writer');
    const revoke = async () =>
      await s.db.app.withBusiness(s.business, async (tx) => await revokeGrant(tx, revoked.grant));
    const second = await behind(work, 'rollback', revoke, revoked.member);
    expect(reasonOf(second)).toMatch(/^42501 .*authority does not cover/u);
    expect(await leasesOn(work['taskId'])).toStrictEqual([]);
  });

  it('a claim whose approved version is superseded while it waits is refused', async () => {
    const work = await approvedWork(s);
    const second = await behind(work, 'rollback', async () => {
      await s.db.app.withBusiness(s.business, async (tx) => {
        await tx.query(
          `update public.proposal_versions set superseded_at = now()
            where business_id = $1 and id = $2`,
          [s.business, work['versionId']],
        );
      });
    });
    expect(reasonOf(second)).toMatch(/^23514 .*not claimable/u);
    expect(await leasesOn(work['taskId'])).toStrictEqual([]);
  });

  it("an agent's claim whose delegation is revoked while it waits is refused", async () => {
    const work = await approvedWork(s);
    const expires = inTenMinutes();
    const minted = await delegation(work['taskId'], expires);
    const agent = [randomUUID(), work['reservationId'], minted, s.agentActorId];
    const revoke = async () =>
      await s.db.app.withBusiness(s.business, async (tx) => await revokeDelegation(tx, minted));
    const second = await claimBehindCompetitor(
      work['reservationId'],
      [...agent, s.decider.personId, expires, 'task'],
      'rollback',
      revoke,
    );
    expect(reasonOf(second)).toMatch(/^42501 .*authority does not cover/u);
    expect(await leasesOn(work['taskId'])).toStrictEqual([]);
  });

  it("an agent's claim whose delegation expires while it waits is refused", async () => {
    const work = await approvedWork(s);
    // Whole seconds, at least two ahead, so the delegation ends while the claim waits.
    const expires = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_000);
    const minted = await delegation(work['taskId'], expires);
    const agent = [randomUUID(), work['reservationId'], minted, s.agentActorId];
    const second = await claimBehindCompetitor(
      work['reservationId'],
      [...agent, s.decider.personId, expires, 'task'],
      'rollback',
      async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, expires.getTime() - Date.now() + 500);
        });
      },
    );
    expect(reasonOf(second)).toMatch(/^(42501 .*authority does not cover|23514 .*lifetime)/u);
    expect(await leasesOn(work['taskId'])).toStrictEqual([]);
  });

  it('a claim cut before its commit leaves no lease, and its retry takes the first fence', async () => {
    const work = await approvedWork(s);
    const parameters = claim(work['reservationId'], s.decider.actorId);
    const cut = await cutTransaction(s.db.appUrl, s.business, 'before-commit', async (tx) => {
      await take(tx, parameters);
    });
    expect(cut.status).toBe('rejected');
    expect(await leasesOn(work['taskId'])).toStrictEqual([]);
    const retried = await s.db.app.withBusiness(
      s.business,
      async (tx) => await take(tx, parameters),
    );
    expect(retried).toBe(1);
  });

  it('a claim whose commit answer is lost leaves one lease, and no retry takes a second', async () => {
    const work = await approvedWork(s);
    const parameters = claim(work['reservationId'], s.decider.actorId);
    const cut = await cutTransaction(s.db.appUrl, s.business, 'after-commit', async (tx) => {
      await take(tx, parameters);
    });
    expect(cut.status).toBe('rejected');
    for (const retry of [parameters, claim(work['reservationId'], s.decider.actorId)]) {
      // oxlint-disable-next-line no-await-in-loop -- one retry at a time
      const [again] = await settle([
        s.db.app.withBusiness(s.business, async (tx) => await take(tx, retry)),
      ]);
      expect(reasonOf(again as PromiseSettledResult<unknown>)).toMatch(/^23505 /u);
    }
    expect(await leasesOn(work['taskId'])).toStrictEqual([{ holder: s.decider.actorId, fence: 1 }]);
  });
});
