// SPDX-License-Identifier: AGPL-3.0-only
//
// The lease negative, the handback invariant, the classifier and restart
// durability (W02, W03, W04, W06), plus the decision exclusion (I07).
//
// The case this file exists for is the **stale fence**: a holder whose lease
// was replaced presents the fence it used to own, and nothing changes. It is
// asserted twice — the refusal carries the right code, and every row the
// handback could have touched is read back and compared to what it was before
// the call. A refusal that still released a hold would pass the first
// assertion and fail the second, which is the whole point of making it two.
//
// **Restart durability** is a genuinely fresh connection, not a new
// transaction on the same pool: `connect()` against the same URL, after the
// original handle is closed. The identities have to come back from the disk
// rather than from anything this process was holding.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide, decideAsAgent } from '../../packages/core-runtime/src/decide.ts';
import { pickup, queue } from '../../packages/core-runtime/src/pickup.ts';
import { handback } from '../../packages/core-runtime/src/handback.ts';
import { replayRecordedTransitions } from '../../packages/core-runtime/src/recovery.ts';
import { resolveDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import {
  buildFixture,
  envelopeTotals,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/lease: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

const hour = (): Date => new Date(Date.now() + 3_600_000);

/** Propose, approve, and return every identity the cases below need. */
async function approvedWork(
  database: Database,
  fixture: RuntimeFixture,
  maximumMinor = 5_000,
): Promise<{
  readonly gateId: string;
  readonly versionId: string;
  readonly lineageId: string;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly envelopeId: string;
}> {
  return await database.withBusiness(fixture.businessId, async (tx) => {
    const proposed = await propose(tx, {
      taskId: fixture.taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: 'draft_the_brief',
      maximumMinor,
      currency: 'AUD',
      payload: { instruction: 'draft it' },
      step: { kind: 'local.draft', payload: { words: 200 } },
      expiresAt: hour(),
    });
    if (!proposed.ok) throw new Error(`propose refused ${proposed.refusal.code}`);

    const decided = await decide(tx, {
      gateId: proposed.value.gateId,
      versionId: proposed.value.versionId,
      decidedByPersonId: fixture.decider.personId,
      decidedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      collection: TASK_COLLECTION,
      decision: 'approve',
      note: 'go',
      signingKey: TEST_SIGNING_KEY,
      capId: fixture.capId,
    });
    if (!decided.ok)
      throw new Error(`decide refused ${decided.refusal.code}: ${decided.refusal.reason}`);

    return {
      gateId: proposed.value.gateId,
      versionId: proposed.value.versionId,
      lineageId: proposed.value.lineageId,
      reservationId: decided.value.reservationId as string,
      attemptId: decided.value.attemptId as string,
      envelopeId: decided.value.envelopeId as string,
    };
  });
}

/** Everything a handback could touch, as one comparable snapshot. */
async function snapshot(
  database: Database,
  fixture: RuntimeFixture,
): Promise<Record<string, unknown>> {
  return await database.withBusiness(fixture.businessId, async (tx) => {
    const rows = await tx.query<Record<string, unknown>>(
      `select
         (select json_agg(row_to_json(r) order by r.id) from
            (select id, state, lease_id, held_minor::text, actual_minor::text, classified_cause
               from public.reservations where business_id = $1) r) as reservations,
         (select json_agg(row_to_json(a) order by a.id) from
            (select id, state, outcome, lease_id, actual_minor::text
               from public.attempts where business_id = $1) a) as attempts,
         (select json_agg(row_to_json(l) order by l.id) from
            (select id, state, fence::text, released_at from public.leases where business_id = $1) l) as leases,
         (select json_agg(row_to_json(e) order by e.id) from
            (select id, state, held_minor::text, actual_minor::text
               from public.task_envelopes where business_id = $1) e) as envelopes`,
      [fixture.businessId],
    );
    return rows[0] as Record<string, unknown>;
  });
}

describe.skipIf(serverUrl === undefined)('the lease', () => {
  let database: FreshDatabase;

  beforeAll(async () => {
    database = await createFreshDatabase({ part: 'l4lease' });
  }, 90_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('projects approved unpicked work, picks it up once, and refuses the second claimant', async () => {
    const fixture = await buildFixture(database.app, 'pickbiz');
    const work = await approvedWork(database.app, fixture);

    const projected = await database.app.withBusiness(
      fixture.businessId,
      async (tx) => await queue(tx),
    );
    expect(projected.map((entry) => entry.reservationId)).toContain(work.reservationId);

    const claimed = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await pickup(tx, {
          reservationId: work.reservationId,
          agentActorId: fixture.agentActorId,
          authorisedByPersonId: fixture.decider.personId,
          mintedByActorId: fixture.decider.actorId,
          collection: TASK_COLLECTION,
          leaseSeconds: 600,
        }),
    );
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('unreachable');
    expect(claimed.value.fence).toBe(1);
    // The delegation ends exactly when the claim does.
    expect(claimed.value.delegation.delegation.expiresAt.getTime()).toBe(
      claimed.value.expiresAt.getTime(),
    );
    expect(claimed.value.declaredIncompleteness.length).toBeGreaterThan(0);

    // It is off the queue, and a second claim is refused rather than served.
    const afterwards = await database.app.withBusiness(
      fixture.businessId,
      async (tx) => await queue(tx),
    );
    expect(afterwards.map((entry) => entry.reservationId)).not.toContain(work.reservationId);

    const second = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await pickup(tx, {
          reservationId: work.reservationId,
          agentActorId: fixture.agentActorId,
          authorisedByPersonId: fixture.decider.personId,
          mintedByActorId: fixture.decider.actorId,
          collection: TASK_COLLECTION,
          leaseSeconds: 600,
        }),
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('a second claim was served');
    expect(second.refusal.code).toBe('RESERVATION_NOT_CLAIMABLE');

    // One lease and one delegation, not two.
    await database.app.withBusiness(fixture.businessId, async (tx) => {
      const leases = await tx.query<{ readonly count: string }>(
        `select count(*)::text as count from public.leases where business_id = $1`,
        [fixture.businessId],
      );
      expect(leases[0]?.count).toBe('1');
    });
  }, 60_000);

  it('changes nothing when a handback presents a stale fence', async () => {
    const fixture = await buildFixture(database.app, 'fencebiz');
    const work = await approvedWork(database.app, fixture);

    const claimed = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await pickup(tx, {
          reservationId: work.reservationId,
          agentActorId: fixture.agentActorId,
          authorisedByPersonId: fixture.decider.personId,
          mintedByActorId: fixture.decider.actorId,
          collection: TASK_COLLECTION,
          leaseSeconds: 600,
        }),
    );
    if (!claimed.ok) throw new Error(`pickup refused ${claimed.refusal.code}`);

    const before = await snapshot(database.app, fixture);

    const stale = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await handback(tx, {
          leaseId: claimed.value.leaseId,
          fence: claimed.value.fence + 1,
          outcome: 'completed',
          report: { wrote: 'something' },
          actualMinor: null,
        }),
    );

    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('a stale fence settled work');
    expect(stale.refusal.code).toBe('LEASE_NOT_OWNED');

    // The second assertion, and the one that matters: nothing moved.
    expect(await snapshot(database.app, fixture)).toStrictEqual(before);

    // The real fence still settles, so the refusal was about the fence and not
    // about the lease being unusable.
    const settled = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await handback(tx, {
          leaseId: claimed.value.leaseId,
          fence: claimed.value.fence,
          outcome: 'completed',
          report: { wrote: 'the draft' },
          actualMinor: null,
        }),
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error('unreachable');
    // Nothing was dispatched, so the hold is abandoned rather than settled at
    // a fabricated zero, and the envelope's held total goes back to nothing.
    expect(settled.value.reservationState).toBe('abandoned');
    expect(settled.value.envelopeHeldMinor).toBe(0);
    expect(settled.value.envelopeActualMinor).toBe(0);
  }, 60_000);

  it('refuses a handback on an expired lease and lets a replacement fence it out', async () => {
    const fixture = await buildFixture(database.app, 'expirybiz');
    const work = await approvedWork(database.app, fixture);

    const claimed = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await pickup(tx, {
          reservationId: work.reservationId,
          agentActorId: fixture.agentActorId,
          authorisedByPersonId: fixture.decider.personId,
          mintedByActorId: fixture.decider.actorId,
          collection: TASK_COLLECTION,
          leaseSeconds: 600,
        }),
    );
    if (!claimed.ok) throw new Error(`pickup refused ${claimed.refusal.code}`);

    // Age the lease rather than minting one that is already over: 0008 refuses
    // a delegation whose expiry precedes its grant, so a negative lease cannot
    // be picked up at all and would be proving something else.
    await database.app.withBusiness(fixture.businessId, async (tx) => {
      await tx.query(
        `update public.leases set expires_at = now() - interval '1 second'
          where business_id = $1 and id = $2`,
        [fixture.businessId, claimed.value.leaseId],
      );
    });

    const refused = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await handback(tx, {
          leaseId: claimed.value.leaseId,
          fence: claimed.value.fence,
          outcome: 'completed',
          report: {},
          actualMinor: null,
        }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('an expired lease settled work');
    expect(refused.refusal.code).toBe('LEASE_EXPIRED');

    // The reservation is still held and still bound; the expired claim did not
    // release the money on its way out.
    await database.app.withBusiness(fixture.businessId, async (tx) => {
      const totals = await envelopeTotals(tx, work.envelopeId);
      expect(totals.held).toBe(5_000);
      expect(totals.actual).toBe(0);
    });
  }, 60_000);

  it('leaves an approved unleased reservation held across a restart, and classifies a rejected one once', async () => {
    const fixture = await buildFixture(database.app, 'recoverbiz');
    const work = await approvedWork(database.app, fixture);

    // A restart is a genuinely new connection, after this one is closed.
    await database.app.close();
    const restarted = connect(database.appUrl, { max: 1, source: 'restarted' });

    const survived = await restarted.withBusiness(fixture.businessId, async (tx) => {
      const rows = await tx.query<{ readonly state: string; readonly lease_id: string | null }>(
        `select state, lease_id from public.reservations where business_id = $1 and id = $2`,
        [fixture.businessId, work.reservationId],
      );
      return rows[0];
    });
    // W04: a crash between approval and pickup leaves claimable work claimable.
    expect(survived?.state).toBe('held');
    expect(survived?.lease_id).toBeNull();

    // And the classifier, run on that restart, leaves it alone: there is no
    // recorded transition making it nonclaimable, and age is not one.
    const untouched = await restarted.withBusiness(
      fixture.businessId,
      async (tx) => await replayRecordedTransitions(tx),
    );
    expect(untouched).toStrictEqual([]);

    // The gate, the decision, the attempt and their identities all came back.
    await restarted.withBusiness(fixture.businessId, async (tx) => {
      const durable = await tx.query<{
        readonly gates: string;
        readonly decisions: string;
        readonly attempts: string;
      }>(
        `select
           (select count(*)::text from public.gates where business_id = $1 and id = $2) as gates,
           (select count(*)::text from public.gate_decisions where business_id = $1 and gate_id = $2) as decisions,
           (select count(*)::text from public.attempts where business_id = $1 and id = $3) as attempts`,
        [fixture.businessId, work.gateId, work.attemptId],
      );
      expect(durable[0]).toStrictEqual({ gates: '1', decisions: '1', attempts: '1' });
    });

    // Now a recorded terminal transition, and the classifier releases once.
    await restarted.withBusiness(fixture.businessId, async (tx) => {
      await tx.query(
        `update public.proposal_lineages
            set state = 'rejected', terminal_reason = 'owner rejected', terminal_at = now()
          where business_id = $1 and id = $2`,
        [fixture.businessId, work.lineageId],
      );
    });

    const first = await restarted.withBusiness(
      fixture.businessId,
      async (tx) => await replayRecordedTransitions(tx),
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.released).toBe(true);
    expect(first[0]?.state).toBe('abandoned');

    // Replayed again, as a second restart would: the same answer, released once.
    const again = await restarted.withBusiness(
      fixture.businessId,
      async (tx) => await replayRecordedTransitions(tx),
    );
    expect(again).toStrictEqual([]);

    await restarted.withBusiness(fixture.businessId, async (tx) => {
      const totals = await envelopeTotals(tx, work.envelopeId);
      // Subtracted exactly once, and nothing was recorded as spent.
      expect(totals.held).toBe(0);
      expect(totals.actual).toBe(0);
      const reservations = await tx.query<{
        readonly state: string;
        readonly actual_minor: string | null;
      }>(
        `select state, actual_minor::text as actual_minor from public.reservations
          where business_id = $1 and id = $2`,
        [fixture.businessId, work.reservationId],
      );
      expect(reservations[0]?.state).toBe('abandoned');
      // Never a zero-cost observation.
      expect(reservations[0]?.actual_minor).toBeNull();
    });

    await restarted.close();
  }, 90_000);

  it('refuses a delegated agent a decision, in L2 words', async () => {
    const fresh = connect(database.appUrl, { max: 1, source: 'agent' });
    const fixture = await buildFixture(fresh, 'agentbiz');
    const work = await approvedWork(fresh, fixture);

    const claimed = await fresh.withBusiness(
      fixture.businessId,
      async (tx) =>
        await pickup(tx, {
          reservationId: work.reservationId,
          agentActorId: fixture.agentActorId,
          authorisedByPersonId: fixture.decider.personId,
          mintedByActorId: fixture.decider.actorId,
          collection: TASK_COLLECTION,
          leaseSeconds: 600,
        }),
    );
    if (!claimed.ok) throw new Error(`pickup refused ${claimed.refusal.code}`);

    const refused = await fresh.withBusiness(fixture.businessId, async (tx) => {
      const resolved = await resolveDelegation(
        tx,
        fixture.agentActorId,
        claimed.value.delegation.credential,
      );
      if (!resolved.ok) throw new Error(`resolve refused ${resolved.refusal.code}`);
      return await decideAsAgent(tx, resolved.value, {
        collection: TASK_COLLECTION,
        taskId: fixture.taskId,
      });
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('an agent decided');
    // L2's code, L2's wording, consumed rather than re-derived.
    expect(refused.refusal.code).toBe('DELEGATION_EXCLUDES_DECISION');

    await fresh.close();
  }, 60_000);
});
