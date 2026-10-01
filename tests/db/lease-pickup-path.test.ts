// SPDX-License-Identifier: AGPL-3.0-only
//
// The pickup path's own checks (`0220_lease_pickup_path`). The application
// role inserts no lease; `public.take_lease` does, as its definer, and only
// for the caller's own business, a claimable reservation, and a claimant the
// authority model covers: a person under their own live write on the task, an
// agent under the delegation minted for this lease from the approving person.
// It computes the fence itself. Pickup calls it after its own checks under the
// locks, so these are the barrier behind them, called straight as the
// application role with no code path in front.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  liveWork,
  openSchedules,
  seedSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { approvedWork, asApp } from './lease-guard-support.ts';

const serverUrl = databaseUrlFromEnvironment();
const TAKE = `select public.take_lease($1, $2, $3, $4, $5, $6, $7)::int as fence`;
const NOT_CLAIMABLE = { code: '23514', message: expect.stringMatching(/not claimable/u) };
const NOT_COVERED = { code: '42501', message: expect.stringMatching(/authority does not cover/u) };

/** Whole seconds, so the delegation and the lease hold the same instant. */
const inTenMinutes = (): Date => new Date(Math.floor(Date.now() / 1000) * 1000 + 600_000);

interface Claim {
  readonly reservation: unknown;
  readonly delegation?: string | null;
  readonly holder: string;
  readonly authorisedBy?: string;
  readonly expires?: Date;
}

// eslint-disable-next-line max-lines-per-function -- four cases over one world
describe.skipIf(serverUrl === undefined)('a lease is taken only through the pickup path', () => {
  let s: Schedules;
  let other: Schedules;
  let stranger: Member;

  beforeAll(async () => {
    s = await openSchedules('lease_path', 1_000_000);
    other = await seedSchedules(s.db, 'lease_path_other', 1_000_000);
    stranger = await enrol(s.db.app, s.business, 'stranger');
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  /** One call of the pickup path as the application role in `business`, rolled back. */
  const take = async (business: string, claim: Claim): ReturnType<typeof asApp> =>
    await asApp(s, business, TAKE, [
      randomUUID(),
      claim.reservation,
      claim.delegation ?? null,
      claim.holder,
      claim.authorisedBy ?? s.decider.personId,
      claim.expires ?? inTenMinutes(),
      'task',
    ]);

  /** A delegation for the agent on `taskId`, from the approving person, ending at `expires`. */
  const delegation = async (taskId: unknown, expires: Date): Promise<string> =>
    await s.db.app.withBusiness(s.business, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: s.agentActorId,
        delegatePersonId: s.decider.personId,
        mintedByActorId: s.decider.actorId,
        purpose: `lease_path_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'comment', 'write'],
        purposeScope: { kind: 'record', id: String(taskId) },
        expiresAt: expires,
      });
      if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
      return minted.value.delegation.id;
    });

  it('the pickup path refuses a lease in another business', async () => {
    const work = await approvedWork(s);
    const home = { reservation: work['reservationId'], holder: s.decider.actorId };
    // Control: at home the decider's own claim is taken, at the task's first fence.
    expect(await take(s.business, home)).toStrictEqual({ accepted: true, rows: [{ fence: 1 }] });

    for (const claim of [home, { ...home, holder: other.decider.actorId }]) {
      // oxlint-disable-next-line no-await-in-loop
      const crossed = await take(other.business, {
        ...claim,
        authorisedBy: other.decider.personId,
      });
      expect(crossed).toMatchObject(NOT_CLAIMABLE);
      if (crossed.accepted) continue;
      for (const id of [work['reservationId'], work['taskId'], s.decider.actorId]) {
        expect(crossed.message).not.toContain(String(id));
      }
    }
    // Control: the other business takes its own work through the same path.
    const theirs = await approvedWork(other);
    const own = await asApp(s, other.business, TAKE, [
      randomUUID(),
      theirs['reservationId'],
      null,
      other.decider.actorId,
      other.decider.personId,
      inTenMinutes(),
      'task',
    ]);
    expect(own).toStrictEqual({ accepted: true, rows: [{ fence: 1 }] });
  });

  it("the pickup path refuses a holder the claimant's authority does not cover", async () => {
    const work = await approvedWork(s);
    const reservation = work['reservationId'];
    // A person with no grant, an agent claiming as a person, a person named as
    // the approver who did not approve.
    expect(await take(s.business, { reservation, holder: stranger.actorId })).toMatchObject(
      NOT_COVERED,
    );
    expect(await take(s.business, { reservation, holder: s.agentActorId })).toMatchObject(
      NOT_COVERED,
    );
    // A person's deactivated actor, whose person still holds the grants.
    const retired = randomUUID();
    await s.db.admin.execute(
      `insert into public.actors (business_id, id, kind, person_id, active, deactivated_at)
       values ($1, $2, 'person', $3, false, now())`,
      [s.business, retired, s.decider.personId],
    );
    expect(await take(s.business, { reservation, holder: retired })).toMatchObject(NOT_COVERED);
    const notTheApprover = { reservation, holder: s.decider.actorId };
    expect(
      await take(s.business, { ...notTheApprover, authorisedBy: stranger.personId }),
    ).toMatchObject(NOT_COVERED);

    // An agent under a delegation minted for other work, or ending at another instant.
    const expires = inTenMinutes();
    const elsewhere = await delegation((await approvedWork(s))['taskId'], expires);
    const agent = { reservation, holder: s.agentActorId, expires };
    expect(await take(s.business, { ...agent, delegation: elsewhere })).toMatchObject(NOT_COVERED);
    const ownTask = await delegation(work['taskId'], expires);
    const later = new Date(expires.getTime() + 1_000);
    expect(await take(s.business, { ...agent, delegation: ownTask, expires: later })).toMatchObject(
      NOT_COVERED,
    );
    // Controls: the agent under its own delegation, and the decider as themselves.
    expect(await take(s.business, { ...agent, delegation: ownTask })).toMatchObject({
      accepted: true,
    });
    expect(await take(s.business, notTheApprover)).toMatchObject({ accepted: true });
  });

  it('a person with live write takes work another person approved, under their own name only', async () => {
    const colleague = await enrol(s.db.app, s.business, 'colleague');
    await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, colleague, 'write'));
    const reservation = (await approvedWork(s))['reservationId'];
    const own = { reservation, holder: colleague.actorId, authorisedBy: colleague.personId };
    // Named under another person's name (here the approver's), the claim is not theirs.
    expect(await take(s.business, { ...own, authorisedBy: s.decider.personId })).toMatchObject(
      NOT_COVERED,
    );
    // Their own live write on the task covers it; approving is not a pickup's authority.
    expect(await take(s.business, own)).toMatchObject({ accepted: true, rows: [{ fence: 1 }] });
  });

  it('the pickup path refuses work that is not claimable, or a lease past its lifetime', async () => {
    const leased = await liveWork(s, `leased ${randomUUID()}`, 2_000);
    const claim = { reservation: leased.decision['reservationId'], holder: s.decider.actorId };
    expect(await take(s.business, claim)).toMatchObject(NOT_CLAIMABLE);
    expect(await take(s.business, { ...claim, reservation: randomUUID() })).toMatchObject(
      NOT_CLAIMABLE,
    );

    const free = { ...claim, reservation: (await approvedWork(s))['reservationId'] };
    const lifetime = { code: '23514', message: expect.stringMatching(/lifetime/u) };
    const tooLong = new Date(Date.now() + 9 * 3_600_000);
    expect(await take(s.business, { ...free, expires: tooLong })).toMatchObject(lifetime);
    const past = new Date(Date.now() - 60_000);
    expect(await take(s.business, { ...free, expires: past })).toMatchObject(lifetime);
    // Control: the same claim with a lease's own length.
    expect(await take(s.business, free)).toMatchObject({ accepted: true });
  });

  it('the pickup path runs as its definer, pinned, and only the application group calls it', async () => {
    const [fn] = await s.db.admin.execute<Record<string, unknown>>(
      `select p.prosecdef as definer, p.proconfig as config,
              has_function_privilege('public', p.oid, 'EXECUTE') as public,
              has_function_privilege('ops_astro_app', p.oid, 'EXECUTE') as application,
              has_function_privilege('ops_astro_worker', p.oid, 'EXECUTE') as worker
         from pg_proc p where p.oid = 'public.take_lease'::regproc`,
    );
    expect(fn).toStrictEqual({
      definer: true,
      config: ['search_path=pg_catalog, pg_temp'],
      public: false,
      application: true,
      worker: false,
    });
    // A call naming nothing takes nothing.
    const none = await asApp(s, s.business, TAKE, [null, null, null, null, null, null, null]);
    expect(none).toStrictEqual({ accepted: true, rows: [{ fence: null }] });
  });
});
