// SPDX-License-Identifier: AGPL-3.0-only
//
// Recorded authority loss for the work a person holds as themselves (EX-01),
// and the limits RUNTIME-LIFECYCLE left on the agent path.
//
// TRANSACTION-CONTRACT T5 line 84 invokes the bounded classifier from
// "recorded authority-loss" operations, and line 86 makes a hold eligible when
// "a recorded grant/delegation/actor revocation invalidates this attempt's
// work authority". A person's lease carries no delegation, so before this
// suite `grant.revoke` never found it: the lease stayed live on a grant that
// no longer existed, and the hold stayed `held` until the lease expired.
//
// Work authority for a claim is `write` on the task's collection: the
// declaration of `task.pickup`, `task.heartbeat` and `task.handback`
// (`surface.ts`), and the check person pickup, renewal and handback each make
// under their locks. Line 86 also keeps "authority restoration or replacement
// work" able to obtain a new attempt, so the run a loss ends goes back to
// `planned`, not to a terminal state: nothing holds it, and it is still
// approved work.
//
// Every revocation goes through the HTTP command entry the product runs. The
// admin writes are the replay case's: a loss that committed without its
// classification, which the fixed handler can no longer produce.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { replayRecordedTransitions } from '../../packages/core-runtime/src/recovery.ts';
import { enrol, grantTo, TASK_COLLECTION, type Member } from '../commands/fixture.ts';
import { createControls, detailOf, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Held {
  readonly taskId: string;
  readonly reservationId: string;
  readonly leaseId: string;
  readonly envelopeId: string;
  readonly runId: string;
  readonly heldMinor: number;
}

describe.skipIf(serverUrl === undefined)('authority loss on a person’s own lease', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('alpl');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  const one = async <T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[],
  ): Promise<T> => {
    const rows = await c.fixture.db.admin.execute<T>(sql, [...parameters]);
    const row = rows[0];
    if (row === undefined) throw new Error(`no row for ${sql}`);
    return row;
  };

  const heldOn = async (envelopeId: string): Promise<number> =>
    Number(
      (
        await one<{ held: string }>(
          `select held_minor::text as held from public.task_envelopes where id = $1`,
          [envelopeId],
        )
      ).held,
    );

  const reservation = async (
    id: string,
  ): Promise<{ state: string; cause: string | null; cause_id: string | null }> =>
    await one(
      `select state, classified_cause as cause, classified_cause_id::text as cause_id
         from public.reservations where id = $1`,
      [id],
    );

  const lease = async (id: string): Promise<{ state: string; expires: string }> =>
    await one(`select state, expires_at::text as expires from public.leases where id = $1`, [id]);

  const runState = async (id: string): Promise<string> =>
    (await one<{ state: string }>(`select state from public.planned_runs where id = $1`, [id]))
      .state;

  /** A person holding read and write on tasks, and the id of that write grant. */
  async function worker(name: string): Promise<{ member: Member; writeId: string }> {
    const member = await enrol(c.fixture.db.app, c.fixture.business, name);
    let writeId = '';
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, member, 'read');
      writeId = await grantTo(tx, member, 'write');
    });
    return { member, writeId };
  }

  /** Proposed and approved by the manager, then picked up by `as` on the person route. */
  async function pickedUpBy(as: Member, purpose: string): Promise<Held> {
    const task = await c.createTask(`a task for ${purpose}`);
    const proposal = await c.propose(task.id, task.revision, purpose);
    const approved = await c.approve(proposal);
    const picked = await c.asPerson(
      'task.pickup',
      { reservationId: approved, leaseSeconds: 600 },
      as,
    );
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const detail = detailOf(picked);
    expect(detail['claimant']).toBe('person');
    const facts = await one<{ envelope_id: string; run_id: string; held: string }>(
      `select envelope_id::text, run_id::text, held_minor::text as held
         from public.reservations where id = $1`,
      [detail['reservationId']],
    );
    return {
      taskId: task.id,
      reservationId: String(detail['reservationId']),
      leaseId: String(detail['leaseId']),
      envelopeId: facts.envelope_id,
      runId: facts.run_id,
      heldMinor: Number(facts.held),
    };
  }

  const replay = async (): Promise<readonly { reservationId: string; released: boolean }[]> =>
    await c.fixture.db.app.withBusiness(c.fixture.business, (tx) => replayRecordedTransitions(tx));

  it('grant.revoke classifies the hold behind a person’s own lease, once, and says which', async () => {
    const { member, writeId } = await worker('person_one');
    const work = await pickedUpBy(member, 'person_loses_write');
    const before = await heldOn(work.envelopeId);
    const leaseBefore = await lease(work.leaseId);

    const revoked = await c.asPerson('grant.revoke', { grantId: writeId });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    // The response names the holds it classified, by id and nothing else.
    expect(detailOf(revoked)).toStrictEqual({
      grantId: writeId,
      revokedAt: expect.any(String),
      classifiedHolds: [work.reservationId],
    });

    expect(await reservation(work.reservationId)).toEqual({
      state: 'abandoned',
      cause: 'authority_revoked',
      cause_id: writeId,
    });
    expect((await lease(work.leaseId)).state).toBe('released');
    expect(await heldOn(work.envelopeId)).toBe(before - work.heldMinor);
    // Nothing holds the run, and it is still approved work.
    expect(await runState(work.runId)).toBe('planned');

    // The person's next renewal and handback are refused and change nothing.
    const renewed = await c.asPerson(
      'task.heartbeat',
      { leaseId: work.leaseId, fence: 1, leaseSeconds: 1_200 },
      member,
    );
    expect(renewed.status).not.toBe(200);
    expect(['SCOPE_NOT_GRANTED', 'LEASE_EXPIRED']).toContain(renewed.body['code']);
    const handedBack = await c.asPerson(
      'task.handback',
      { leaseId: work.leaseId, fence: 1, outcome: 'completed' },
      member,
    );
    expect(handedBack.status).not.toBe(200);
    expect(await lease(work.leaseId)).toEqual({ ...leaseBefore, state: 'released' });
    expect(
      await c.count(
        `select count(*)::text as n from public.handback_reports where lease_id = $1 and disposition = 'settled'`,
        [work.leaseId],
      ),
    ).toBe(0);
    expect(await heldOn(work.envelopeId)).toBe(before - work.heldMinor);

    // Replay finds nothing left to do, and a second revocation moves no money.
    const replayed = await replay();
    expect(replayed.filter((row) => row.reservationId === work.reservationId)).toEqual([]);
    const twice = await c.asPerson('grant.revoke', { grantId: writeId });
    expect(twice.body['code']).toBe('TRANSITION_NOT_PERMITTED');
    expect(await heldOn(work.envelopeId)).toBe(before - work.heldMinor);
  });

  it('a revoked actor-subject write grant is a loss too: pickup read it', async () => {
    const member = await enrol(c.fixture.db.app, c.fixture.business, 'person_actor');
    let writeId = '';
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, member, 'read');
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'actor', id: member.actorId },
        scope: { kind: 'business', id: null },
        collection: TASK_COLLECTION,
        action: 'write',
        parentGrantId: null,
        grantedByActorId: member.actorId,
      });
      if (!issued.ok) throw new Error(issued.refusal.code);
      writeId = issued.value;
    });
    const work = await pickedUpBy(member, 'person_actor_loses_write');
    const before = await heldOn(work.envelopeId);

    const revoked = await c.asPerson('grant.revoke', { grantId: writeId });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(detailOf(revoked)['classifiedHolds']).toStrictEqual([work.reservationId]);
    expect((await reservation(work.reservationId)).state).toBe('abandoned');
    expect((await lease(work.leaseId)).state).toBe('released');
    expect(await heldOn(work.envelopeId)).toBe(before - work.heldMinor);
  });

  it('leaves a person’s lease alone when another live write still covers the task', async () => {
    const { member, writeId } = await worker('person_kept');
    const work = await pickedUpBy(member, 'person_keeps_write');
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, member, 'write', { kind: 'record', id: work.taskId });
    });
    const before = await heldOn(work.envelopeId);

    const revoked = await c.asPerson('grant.revoke', { grantId: writeId });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(detailOf(revoked)['classifiedHolds']).toStrictEqual([]);
    expect((await reservation(work.reservationId)).state).toBe('held');
    expect((await lease(work.leaseId)).state).toBe('live');
    expect(await runState(work.runId)).toBe('claimed');
    expect(await heldOn(work.envelopeId)).toBe(before);
  });

  it('only write is work authority: revoking a person’s read leaves their claim', async () => {
    const member = await enrol(c.fixture.db.app, c.fixture.business, 'person_read');
    let readId = '';
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      readId = await grantTo(tx, member, 'read');
      await grantTo(tx, member, 'write');
    });
    const work = await pickedUpBy(member, 'person_loses_read');

    const revoked = await c.asPerson('grant.revoke', { grantId: readId });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(detailOf(revoked)['classifiedHolds']).toStrictEqual([]);
    expect((await reservation(work.reservationId)).state).toBe('held');
    expect((await lease(work.leaseId)).state).toBe('live');
  });

  it('a person whose write is restored claims the same approved work as a fresh attempt', async () => {
    const { member, writeId } = await worker('person_restored');
    const work = await pickedUpBy(member, 'person_restored_work');
    const revoked = await c.asPerson('grant.revoke', { grantId: writeId });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, member, 'write');
    });
    const again = await c.asPerson(
      'task.pickup',
      { reservationId: work.reservationId, leaseSeconds: 600 },
      member,
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(detailOf(again)['reservationId']).not.toBe(work.reservationId);
    expect(await runState(work.runId)).toBe('claimed');
    expect((await reservation(work.reservationId)).state).toBe('abandoned');
  });

  it('delegation.revoke lists its classified hold and hands the run back to planned', async () => {
    const task = await c.createTask('an agent task for revocation');
    const proposal = await c.propose(task.id, task.revision, 'agent_loses_delegation');
    const picked = await c.pickup(await c.approve(proposal));
    const reservationId = String(picked['reservationId']);
    const runId = (
      await one<{ run_id: string }>(`select run_id::text from public.reservations where id = $1`, [
        reservationId,
      ])
    ).run_id;

    const revoked = await c.asPerson('delegation.revoke', {
      delegationId: picked['delegationId'],
    });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(detailOf(revoked)).toStrictEqual({
      delegationId: picked['delegationId'],
      revokedAt: expect.any(String),
      classifiedHolds: [reservationId],
    });
    expect(await runState(runId)).toBe('planned');
  });

  it('replay finishes a committed person-lease loss exactly once', async () => {
    const { member, writeId } = await worker('person_replay');
    const work = await pickedUpBy(member, 'person_replay_loss');
    const before = await heldOn(work.envelopeId);
    // A loss that committed without its classification: the grant revoked and
    // the lease released, the hold still held and the run still claimed.
    await c.fixture.db.admin.execute(`update public.grants set revoked_at = now() where id = $1`, [
      writeId,
    ]);
    await c.fixture.db.admin.execute(
      `update public.leases set state = 'released', released_at = now() where id = $1`,
      [work.leaseId],
    );

    const first = await replay();
    const mine = first.filter((row) => row.reservationId === work.reservationId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.released).toBe(true);
    expect((await reservation(work.reservationId)).state).toBe('abandoned');
    expect(await heldOn(work.envelopeId)).toBe(before - work.heldMinor);

    const second = await replay();
    expect(second.filter((row) => row.released)).toEqual([]);
    expect(await heldOn(work.envelopeId)).toBe(before - work.heldMinor);
  });

  it('replay of a committed agent revocation hands the run back to planned', async () => {
    const task = await c.createTask('an agent task for replay');
    const proposal = await c.propose(task.id, task.revision, 'agent_replay_loss');
    const picked = await c.pickup(await c.approve(proposal));
    const reservationId = String(picked['reservationId']);
    const runId = (
      await one<{ run_id: string }>(`select run_id::text from public.reservations where id = $1`, [
        reservationId,
      ])
    ).run_id;
    await c.fixture.db.admin.execute(
      `update public.delegations set revoked_at = now() where id = $1`,
      [picked['delegationId']],
    );

    const first = await replay();
    expect(first.filter((row) => row.reservationId === reservationId)).toHaveLength(1);
    expect((await reservation(reservationId)).state).toBe('abandoned');
    expect(await runState(runId)).toBe('planned');
  });
});
