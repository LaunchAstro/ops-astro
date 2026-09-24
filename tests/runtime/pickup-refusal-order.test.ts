// SPDX-License-Identifier: AGPL-3.0-only
//
// The refusal order inside `pickup`'s expired-lease branch.
//
// That branch used to write before it checked: it fenced the old lease,
// classified the old hold and opened the replacement hold, and only then asked
// whether the approval behind the reservation was still current. Thermo O6,
// lead ruling: the check is hoisted above every write, in both replacement
// branches. So a stale approval is now the answer even when the old hold could
// not have been released, and the branch writes nothing before it refuses.
//
// The first case is the one whose answer the ruling changed. It needs a hold
// the classifier cannot release. Under pickup's
// locks nothing reachable produces one: the reservation row is locked and read
// as held and unmarked, and the fence leaves the lease no longer live. The one
// row pickup does not lock is the attempt, so the case raises its marker (and
// the quarantined state 0014's check pairs with it) straight after the fence,
// in the same transaction. That is where a marker committed by another session
// between those two statements would land, and it is the only route to the
// classifier's refusal from this branch.
//
// "Nothing committed" is asserted the way the command envelope provides it: a
// savepoint around the call, rolled back on the refusal. Inside that savepoint
// every row is read back first, so the pin records that nothing was written.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import { pickup } from '../../packages/core-runtime/src/pickup.ts';
import {
  buildFixture,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/pickup-refusal-order: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const hour = (): Date => new Date(Date.now() + 3_600_000);

interface Held {
  readonly versionId: string;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly leaseId: string;
}

/** Approved work, picked up, its lease aged past expiry and its version superseded. */
async function staleExpiredClaim(database: Database, fixture: RuntimeFixture): Promise<Held> {
  const work = await database.withBusiness(fixture.businessId, async (tx) => {
    const proposed = await propose(tx, {
      taskId: fixture.taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: 'draft_the_brief',
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
    return {
      versionId: proposed.value.versionId,
      reservationId: decided.value.reservationId as string,
      attemptId: decided.value.attemptId as string,
    };
  });

  const claimed = await database.withBusiness(
    fixture.businessId,
    async (tx) => await pickup(tx, request(fixture, work.reservationId)),
  );
  if (!claimed.ok) throw new Error(`pickup refused ${claimed.refusal.code}`);

  await database.withBusiness(fixture.businessId, async (tx) => {
    await tx.query(
      `update public.leases set expires_at = now() - interval '1 second'
        where business_id = $1 and id = $2`,
      [fixture.businessId, claimed.value.leaseId],
    );
    await tx.query(
      `update public.proposal_versions set superseded_at = now()
        where business_id = $1 and id = $2`,
      [fixture.businessId, work.versionId],
    );
  });
  return { ...work, leaseId: claimed.value.leaseId };
}

function request(fixture: RuntimeFixture, reservationId: string) {
  return {
    reservationId,
    agentActorId: fixture.agentActorId,
    authorisedByPersonId: fixture.decider.personId,
    mintedByActorId: fixture.decider.actorId,
    collection: TASK_COLLECTION,
    leaseSeconds: 600,
  };
}

/** The same transaction, with the attempt's marker raised straight after the fence. */
function markAfterFence(tx: TenantQuery, attemptId: string): TenantQuery {
  let marked = false;
  return {
    businessId: tx.businessId,
    async query<Row>(text: string, parameters?: readonly unknown[]) {
      const rows = await tx.query<Row>(text, parameters);
      // The fence is `endLease(..., 'expired')`: the lease update whose new
      // state is `expired`, whichever way the statement spells it.
      const fence =
        text.trim().startsWith('update public.leases set state =') &&
        (text.includes("state = 'expired'") || parameters?.includes('expired') === true);
      if (!marked && fence) {
        marked = true;
        await tx.query(
          `update public.attempts set dispatch_marker = true, state = 'quarantined'
            where business_id = $1 and id = $2`,
          [tx.businessId, attemptId],
        );
      }
      return rows;
    },
  };
}

/** Every row the branch could touch, as one comparable value. */
async function rowsOf(tx: TenantQuery): Promise<unknown> {
  const rows = await tx.query<{ readonly v: unknown }>(
    `select json_build_object(
       'reservations', (select json_agg(json_build_object('id', id, 'state', state,
                          'lease', lease_id, 'held', held_minor::text) order by id)
                          from public.reservations where business_id = $1),
       'attempts', (select json_agg(json_build_object('id', id, 'state', state,
                      'marked', dispatch_marker, 'outcome', outcome) order by id)
                      from public.attempts where business_id = $1),
       'leases', (select json_agg(json_build_object('id', id, 'state', state,
                    'released', released_at) order by id)
                    from public.leases where business_id = $1),
       'envelopes', (select json_agg(json_build_object('id', id, 'held', held_minor::text,
                       'actual', actual_minor::text) order by id)
                       from public.task_envelopes where business_id = $1)) as v`,
    [tx.businessId],
  );
  return rows[0]?.v;
}

async function stateOf(tx: TenantQuery, table: string, id: string): Promise<string | undefined> {
  const rows = await tx.query<{ readonly state: string }>(
    `select state from public.${table} where business_id = $1 and id = $2`,
    [tx.businessId, id],
  );
  return rows[0]?.state;
}

describe.skipIf(serverUrl === undefined)('pickup refusal order', () => {
  let database: FreshDatabase;

  beforeAll(async () => {
    database = await createFreshDatabase({ part: 'pickorder' });
  }, 90_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('refuses the stale approval before the fence, even when the old hold could not be released', async () => {
    const fixture = await buildFixture(database.app, 'orderhold');
    const held = await staleExpiredClaim(database.app, fixture);
    const before = await database.app.withBusiness(fixture.businessId, rowsOf);

    const refused = await database.app.withBusiness(fixture.businessId, async (tx) => {
      await tx.query('savepoint pin');
      const result = await pickup(
        markAfterFence(tx, held.attemptId),
        request(fixture, held.reservationId),
      );
      // Nothing written before the refusal: no fence, so the marker hook never
      // fired, and no classification or replacement hold.
      expect(await rowsOf(tx)).toStrictEqual(before);
      expect(await stateOf(tx, 'leases', held.leaseId)).toBe('live');
      await tx.query('rollback to savepoint pin');
      return result;
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('a stale, unreleasable hold was claimed');
    expect(refused.refusal).toStrictEqual({
      code: 'RESERVATION_NOT_CLAIMABLE',
      reason: 'the approval behind this reservation is no longer current',
      fix: 'Re-read the queue. A superseded or terminal approval authorises nothing.',
    });

    const after = await database.app.withBusiness(fixture.businessId, rowsOf);
    expect(after).toStrictEqual(before);
  }, 60_000);

  it('refuses the stale approval before any write when the old hold could be released', async () => {
    const fixture = await buildFixture(database.app, 'orderstale');
    const held = await staleExpiredClaim(database.app, fixture);
    const before = await database.app.withBusiness(fixture.businessId, rowsOf);

    const refused = await database.app.withBusiness(fixture.businessId, async (tx) => {
      await tx.query('savepoint pin');
      const result = await pickup(tx, request(fixture, held.reservationId));
      // Nothing written before the refusal: no fence, no release, no fresh hold.
      expect(await rowsOf(tx)).toStrictEqual(before);
      await tx.query('rollback to savepoint pin');
      return result;
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('a stale approval was claimed');
    expect(refused.refusal).toStrictEqual({
      code: 'RESERVATION_NOT_CLAIMABLE',
      reason: 'the approval behind this reservation is no longer current',
      fix: 'Re-read the queue. A superseded or terminal approval authorises nothing.',
    });

    const after = await database.app.withBusiness(fixture.businessId, rowsOf);
    expect(after).toStrictEqual(before);
  }, 60_000);
});
