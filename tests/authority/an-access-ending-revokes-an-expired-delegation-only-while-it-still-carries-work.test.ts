// SPDX-License-Identifier: AGPL-3.0-only
//
// `access.end` revokes the delegations the ending person gave, and counts in
// `delegationsRevoked` only those that were still live. One that has already
// expired and carries no live work is not written at all
// (c58-end-access-race.test.ts). One that has expired but still carries a live
// agent attempt is different: that attempt's hold is classified
// `authority_revoked` on the delegation, and the classifier accepts that cause
// only once the delegation records a revocation. So the ending still records
// the revocation, releases its lease and abandons its hold, but the expired
// delegation is not counted: it was not live authority when the act ran.
//
// An agent attempt of the departing person's delegation that was marked
// observed keeps its whole hold as quarantined, and every remaining manager of
// the task is told; the departing person, a manager of it too, is not.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Answer } from '../api/fixture.ts';
import { createControls, detailOf, type Controls } from '../api/controls-fixture.ts';
import { enrol, grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

let c: Controls;

interface Delegated {
  readonly leaver: Member;
  readonly task: { readonly id: string };
  readonly proposal: Readonly<Record<string, unknown>>;
  readonly picked: Readonly<Record<string, unknown>>;
}

/**
 * A person who approves their own task's proposal, so the agent's pickup
 * mints its delegation from them; the manager may end their access.
 */
async function delegatedWork(purpose: string, name: string): Promise<Delegated> {
  const leaver = await enrol(c.fixture.db.app, c.fixture.business, name);
  await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
    for (const action of ['read', 'comment', 'decide', 'write'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- `issueGrant` reads the granter's own rows
      await grantTo(tx, leaver, action);
    }
    await grantTo(tx, c.manager, 'manage', WHOLE_BUSINESS, false, 'access');
  });
  const task = await c.createTask(`work for ${purpose}`);
  const proposal = await c.propose(task.id, task.revision, purpose);
  const decided = await c.asPerson(
    'task.decide',
    {
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'approved',
    },
    leaver,
  );
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  const picked = await c.pickup(String(detailOf(decided)['reservationId']));
  const [delegation] = await c.fixture.db.admin.execute<{ person: string }>(
    'select delegate_person_id::text as person from public.delegations where id = $1',
    [picked['delegationId']],
  );
  expect(delegation?.person).toBe(leaver.personId);
  return { leaver, task, proposal, picked };
}

interface Ended {
  readonly status: number;
  readonly delegationsRevoked: unknown;
  readonly classifiedHolds: unknown;
  readonly reservation: { state: string; cause: string | null; cause_id: string | null };
  readonly lease: string;
  readonly revoked: boolean;
}

/** What the ending answered, and the hold, lease and delegation it left. */
async function leftBehind(answer: Answer, work: Delegated): Promise<Ended> {
  const db = c.fixture.db.admin;
  const [reservation] = await db.execute<Ended['reservation']>(
    `select state, classified_cause as cause, classified_cause_id::text as cause_id
       from public.reservations where id = $1`,
    [work.picked['reservationId']],
  );
  const [lease] = await db.execute<{ state: string }>(
    'select state from public.leases where id = $1',
    [work.picked['leaseId']],
  );
  const [delegation] = await db.execute<{ revoked: boolean }>(
    'select revoked_at is not null as revoked from public.delegations where id = $1',
    [work.picked['delegationId']],
  );
  return {
    status: answer.status,
    delegationsRevoked: detailOf(answer)['delegationsRevoked'],
    classifiedHolds: detailOf(answer)['classifiedHolds'],
    reservation: reservation ?? { state: 'missing', cause: null, cause_id: null },
    lease: lease?.state ?? 'missing',
    revoked: delegation?.revoked ?? false,
  };
}

/** The reservation's state and hold, and its envelope's held total. */
const money = async (reservationId: unknown) =>
  await c.fixture.db.admin.execute<{ state: string; held: string; envelope_held: string }>(
    `select r.state, r.held_minor::text as held, e.held_minor::text as envelope_held
       from public.reservations r join public.task_envelopes e on e.id = r.envelope_id
      where r.id = $1`,
    [reservationId],
  );

/** The open incident items on the task's run, by recipient. */
const incidents = async (work: Delegated) =>
  await c.fixture.db.admin.execute<{ recipient: string; owed: boolean }>(
    `select recipient_person_id::text as recipient, owed from public.inbox_items
      where business_id = $1 and subject_record_id = $2 and reason = 'incident'
        and fact_kind = 'planned_run' and fact_id = $3 and work_state = 'open'
      order by recipient_person_id`,
    [c.fixture.business, work.task.id, work.proposal['runId']],
  );

async function endedOverExpiredWork(): Promise<{ work: Delegated; ended: Ended }> {
  const work = await delegatedWork('expiring_delegation_work', 'Ari Approver');
  await c.fixture.db.admin.execute(
    `update public.delegations
        set granted_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
      where id = $1`,
    [work.picked['delegationId']],
  );
  const answer = await c.asPerson('access.end', { holderId: work.leaver.personId });
  return { work, ended: await leftBehind(answer, work) };
}

async function endedOverMarkedWork(): Promise<void> {
  const work = await delegatedWork('marked_delegation_work', 'Lee Leaving');
  await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
    await grantTo(tx, c.reader, 'manage', { kind: 'record', id: work.task.id });
    await grantTo(tx, work.leaver, 'manage', { kind: 'record', id: work.task.id });
  });
  const before = await money(work.picked['reservationId']);
  expect(before[0]?.state).toBe('held');
  expect(BigInt(before[0]?.held ?? '0')).toBeGreaterThan(0n);
  await c.fixture.db.admin.execute(
    `update public.attempts set observed = true, state = 'quarantined' where id = $1`,
    [work.picked['attemptId']],
  );
  const ended = await c.asPerson('access.end', { holderId: work.leaver.personId });
  expect(ended.status, JSON.stringify(ended.body)).toBe(200);
  expect(detailOf(ended)['classifiedHolds']).toEqual([work.picked['reservationId']]);
  expect(await money(work.picked['reservationId'])).toEqual([
    { ...before[0], state: 'quarantined' },
  ]);
  expect(await incidents(work)).toEqual(
    [c.manager.personId, c.reader.personId]
      .toSorted()
      .map((recipient) => ({ recipient, owed: true })),
  );
}

describe.skipIf(serverUrl === undefined)(
  'an access ending over a delegation that still carries work',
  () => {
    beforeAll(async () => {
      c = await createControls('end_expired_work');
    }, 120_000);
    afterAll(async () => {
      await c?.drop();
    });

    it('classifies the work of an expired delegation and does not count that delegation as revoked', async () => {
      const { work, ended } = await endedOverExpiredWork();
      expect(ended).toEqual({
        status: 200,
        delegationsRevoked: 0,
        classifiedHolds: [work.picked['reservationId']],
        reservation: {
          state: 'abandoned',
          cause: 'authority_revoked',
          cause_id: work.picked['delegationId'],
        },
        lease: 'released',
        revoked: true,
      });
    }, 60_000);

    it("keeps a marked agent attempt's full hold and tells every remaining task manager but the departing one", async () => {
      await endedOverMarkedWork();
    }, 60_000);
  },
);
