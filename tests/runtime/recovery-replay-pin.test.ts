// SPDX-License-Identifier: AGPL-3.0-only
//
// A pin on the set restart replay finds, one row for each way a hold becomes
// eligible and one for each way it stays claimable.
//
// It exists so that a change to the discovery query's joins can be checked
// against the same answer before and after. Each eligible row names its own
// recorded cause, and the two claimable rows (unleased, and leased live) must
// never appear, because age and a missing claimant are not causes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { revokeDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import { pickup } from '../../packages/core-runtime/src/pickup.ts';
import {
  replayRecordedTransitions,
  type Classification,
} from '../../packages/core-runtime/src/recovery.ts';
import {
  buildFixture,
  newTask,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/recovery-replay-pin: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const hour = (): Date => new Date(Date.now() + 3_600_000);

/** What the classifier returns for a hold it released under a recorded cause. */
const released = (reservationId: string, cause: string, causeId: string): Classification => ({
  reservationId,
  released: true,
  state: 'abandoned',
  reason: `abandoned under ${cause} (${causeId}); the hold was released once and no cost was recorded`,
});

interface Approved {
  readonly reservationId: string;
  readonly lineageId: string;
}

interface Claimed extends Approved {
  readonly leaseId: string;
  readonly delegationId: string;
}

describe.skipIf(serverUrl === undefined)('restart replay: the discovered set', () => {
  let database: FreshDatabase;
  let fixture: RuntimeFixture;

  beforeAll(async () => {
    database = await createFreshDatabase({ part: 'replaypin' });
    fixture = await buildFixture(database.app, 'replaypinbiz');
  }, 90_000);

  afterAll(async () => {
    await database?.drop();
  });

  /** Propose and approve on a task of its own, under its own purpose. */
  const approve = async (purpose: string): Promise<Approved> => {
    const taskId = await newTask(database.app, fixture.businessId, fixture.decider);
    return await database.app.withBusiness(fixture.businessId, async (tx) => {
      const proposed = await propose(tx, {
        taskId,
        collection: TASK_COLLECTION,
        proposedByActorId: fixture.decider.actorId,
        subjects: subjectsOf(fixture.decider),
        purpose,
        maximumMinor: 5_000,
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
      if (!decided.ok) throw new Error(`decide refused ${decided.refusal.code}`);
      if (decided.value.decision !== 'approve')
        throw new Error(`expected an approval, got ${decided.value.decision}`);
      return {
        reservationId: decided.value.reservationId,
        lineageId: proposed.value.lineageId,
      };
    });
  };

  /** Approved, then picked up by the fixture's agent, so the hold is bound to a live lease. */
  const claim = async (purpose: string): Promise<Claimed> => {
    const approved = await approve(purpose);
    const claimed = await database.app.withBusiness(
      fixture.businessId,
      async (tx) =>
        await pickup(tx, {
          claimant: 'agent',
          reservationId: approved.reservationId,
          agentActorId: fixture.agentActorId,
          authorisedByPersonId: fixture.decider.personId,
          mintedByActorId: fixture.decider.actorId,
          collection: TASK_COLLECTION,
          leaseSeconds: 3_600,
        }),
    );
    if (!claimed.ok) throw new Error(`pickup refused ${claimed.refusal.code}`);
    return {
      ...approved,
      leaseId: claimed.value.leaseId,
      delegationId: claimed.value.delegation.delegation.id,
    };
  };

  it('finds each recorded transition once, in reservation order, and nothing claimable', async () => {
    // Claimable, and so never in the set.
    await approve('pin_unleased');
    await claim('pin_live');

    // A lease the server fenced, and one released, with the hold left bound to each.
    const expired = await claim('pin_expired');
    await database.admin.execute(
      `update public.leases set state = 'expired', released_at = now() where id = $1`,
      [expired.leaseId],
    );
    const fenced = await claim('pin_released');
    await database.admin.execute(
      `update public.leases set state = 'released', released_at = now() where id = $1`,
      [fenced.leaseId],
    );

    // A terminal lineage, on work nobody picked up.
    const rejected = await approve('pin_rejected');
    await database.admin.execute(
      `update public.proposal_lineages
          set state = 'rejected', terminal_reason = 'owner rejected', terminal_at = now()
        where id = $1`,
      [rejected.lineageId],
    );

    // A revocation that committed without its classification, lease still live.
    const revoked = await claim('pin_revoked');
    await database.app.withBusiness(fixture.businessId, async (tx) => {
      await revokeDelegation(tx, revoked.delegationId);
    });

    const expected = [
      released(expired.reservationId, 'lease_expired_and_fenced', expired.leaseId),
      released(fenced.reservationId, 'lease_expired_and_fenced', fenced.leaseId),
      released(rejected.reservationId, 'lineage_rejected', rejected.lineageId),
      released(revoked.reservationId, 'authority_revoked', revoked.delegationId),
    ].toSorted((left, right) => (left.reservationId < right.reservationId ? -1 : 1));

    const replayed = await database.app.withBusiness(
      fixture.businessId,
      async (tx) => await replayRecordedTransitions(tx),
    );
    expect(replayed).toStrictEqual(expected);

    // Replayed again, the same set is already terminal and nothing is found.
    const again = await database.app.withBusiness(
      fixture.businessId,
      async (tx) => await replayRecordedTransitions(tx),
    );
    expect(again).toStrictEqual([]);
  }, 120_000);
});
