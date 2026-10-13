// SPDX-License-Identifier: AGPL-3.0-only
//
// `access.end` revokes the delegations the ending person gave. One that has
// already expired and carries no live work has nothing left to revoke and is
// not counted (c58-end-access-race.test.ts). One that has expired but still
// carries a live agent attempt is different: that attempt's hold is classified
// `authority_revoked` on the delegation, and the classifier accepts that cause
// only once the delegation records a revocation. So the ending still revokes
// it, counts that write, releases its lease and abandons its hold, exactly as
// it does for a live delegation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Answer } from '../api/fixture.ts';
import { createControls, detailOf, type Controls } from '../api/controls-fixture.ts';
import { enrol, grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

let c: Controls;

interface Ended {
  readonly status: number;
  readonly delegationsRevoked: unknown;
  readonly reservation: { state: string; cause: string | null; cause_id: string | null };
  readonly lease: string;
  readonly revoked: boolean;
}

/**
 * An approver's agent attempt, picked up under the delegation it mints and
 * holding its reservation, with that delegation then expired; the approver's
 * access ended by the manager; what the act answered and left behind.
 */
async function endedOverExpiredWork(): Promise<{ delegationId: string; ended: Ended }> {
  const approver = await enrol(c.fixture.db.app, c.fixture.business, 'Ari Approver');
  await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
    for (const action of ['read', 'comment', 'decide', 'write'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- `issueGrant` reads the granter's own rows
      await grantTo(tx, approver, action);
    }
    await grantTo(tx, c.manager, 'manage', WHOLE_BUSINESS, false, 'access');
  });
  const task = await c.createTask('work under a delegation that expires');
  const proposal = await c.propose(task.id, task.revision, 'expiring_delegation_work');
  const decided = await c.asPerson(
    'task.decide',
    {
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'approved',
    },
    approver,
  );
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  const picked = await c.pickup(String(detailOf(decided)['reservationId']));
  const delegationId = String(picked['delegationId']);
  const db = c.fixture.db.admin;
  await db.execute(
    `update public.delegations
        set granted_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
      where id = $1`,
    [delegationId],
  );

  const answer = await c.asPerson('access.end', { holderId: approver.personId });
  return { delegationId, ended: await leftBehind(answer, picked, delegationId) };
}

/** What the ending answered, and the hold, lease and delegation it left. */
async function leftBehind(
  answer: Answer,
  picked: Readonly<Record<string, unknown>>,
  delegationId: string,
): Promise<Ended> {
  const db = c.fixture.db.admin;
  const [reservation] = await db.execute<Ended['reservation']>(
    `select state, classified_cause as cause, classified_cause_id::text as cause_id
       from public.reservations where id = $1`,
    [picked['reservationId']],
  );
  const [lease] = await db.execute<{ state: string }>(
    'select state from public.leases where id = $1',
    [picked['leaseId']],
  );
  const [delegation] = await db.execute<{ revoked: boolean }>(
    'select revoked_at is not null as revoked from public.delegations where id = $1',
    [delegationId],
  );
  return {
    status: answer.status,
    delegationsRevoked: detailOf(answer)['delegationsRevoked'],
    reservation: reservation ?? { state: 'missing', cause: null, cause_id: null },
    lease: lease?.state ?? 'missing',
    revoked: delegation?.revoked ?? false,
  };
}

describe.skipIf(serverUrl === undefined)(
  'an access ending over an expired delegation that still carries work',
  () => {
    beforeAll(async () => {
      c = await createControls('end_expired_work');
    }, 120_000);
    afterAll(async () => {
      await c?.drop();
    });

    it('revokes and counts it, releases its lease and abandons its hold as authority_revoked', async () => {
      const { delegationId, ended } = await endedOverExpiredWork();
      expect(ended).toEqual({
        status: 200,
        delegationsRevoked: 1,
        reservation: { state: 'abandoned', cause: 'authority_revoked', cause_id: delegationId },
        lease: 'released',
        revoked: true,
      });
    }, 60_000);
  },
);
