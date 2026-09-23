// SPDX-License-Identifier: AGPL-3.0-only
//
// F4 (runtime review): recorded authority loss classifies the holds it makes
// nonclaimable, and restart replay can find one whose classification did not
// commit.
//
// T5, TRANSACTION-CONTRACT lines 84-92: the bounded classifier is invoked from
// "recorded authority-loss" operations, and a hold is eligible when "a
// recorded grant/delegation/actor revocation invalidates this attempt's work
// authority". Before this suite `delegation.revoke` and `grant.revoke`
// timestamped the row and returned, the lease stayed live and the hold stayed
// `held`; replay looked only at terminal lineages, superseded versions and
// terminal leases, so nothing ever classified it; and the classifier accepted
// `authority_revoked` on the caller's word.
//
// The revocations go through the HTTP command entry the product runs. The one
// admin write is the replay case's: a revocation that committed without its
// classification, which the fixed handler can no longer produce.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { acquire } from '../../packages/core-runtime/src/locks.ts';
import {
  classifyUnderLocks,
  replayRecordedTransitions,
} from '../../packages/core-runtime/src/recovery.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { createControls, detailOf, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Picked {
  readonly taskId: string;
  readonly reservationId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly delegationId: string;
  readonly envelopeId: string;
  readonly heldMinor: number;
}

describe.skipIf(serverUrl === undefined)('recorded authority loss classifies its holds', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('lcauth');
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

  const leaseState = async (id: string): Promise<string> =>
    (await one<{ state: string }>(`select state from public.leases where id = $1`, [id])).state;

  const delegationRevoked = async (id: string): Promise<boolean> =>
    (
      await one<{ revoked: boolean }>(
        `select (revoked_at is not null) as revoked from public.delegations where id = $1`,
        [id],
      )
    ).revoked;

  /** Propose as the manager, approve as `approver`, pick up as the agent. */
  async function pickedUp(purpose: string, approver?: Member): Promise<Picked> {
    const task = await c.createTask(`a task for ${purpose}`);
    const proposal = await c.propose(task.id, task.revision, purpose);
    let reservationId: string;
    if (approver === undefined) {
      reservationId = await c.approve(proposal);
    } else {
      const decided = await c.asPerson(
        'task.decide',
        {
          gateId: proposal['gateId'],
          versionId: proposal['versionId'],
          decision: 'approve',
          note: 'approved by a second person',
        },
        approver,
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      reservationId = String(detailOf(decided)['reservationId']);
    }
    const picked = await c.pickup(reservationId);
    const res = await one<{ envelope_id: string; held: string }>(
      `select envelope_id::text, held_minor::text as held from public.reservations where id = $1`,
      [picked['reservationId']],
    );
    return {
      taskId: task.id,
      reservationId: String(picked['reservationId']),
      attemptId: String(picked['attemptId']),
      leaseId: String(picked['leaseId']),
      delegationId: String(picked['delegationId']),
      envelopeId: res.envelope_id,
      heldMinor: Number(res.held),
    };
  }

  /** A second person who may decide, and whose write grant the manager can revoke. */
  async function approverWithGrants(name: string): Promise<{ member: Member; writeId: string }> {
    const member = await enrol(c.fixture.db.app, c.fixture.business, name);
    let writeId = '';
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      for (const action of ['read', 'comment', 'decide'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, member, action);
      }
      writeId = await grantTo(tx, member, 'write');
    });
    return { member, writeId };
  }

  it('(a) delegation.revoke releases the lease and abandons the hold once, as authority_revoked', async () => {
    const work = await pickedUp('auth_loss_delegation');
    const before = await heldOn(work.envelopeId);

    const revoked = await c.asPerson('delegation.revoke', { delegationId: work.delegationId });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    expect(await reservation(work.reservationId)).toEqual({
      state: 'abandoned',
      cause: 'authority_revoked',
      cause_id: work.delegationId,
    });
    expect(await leaseState(work.leaseId)).toBe('released');
    expect(await delegationRevoked(work.delegationId)).toBe(true);
    expect(await heldOn(work.envelopeId)).toBe(before - work.heldMinor);

    // A second revocation is refused and moves no money.
    const twice = await c.asPerson('delegation.revoke', { delegationId: work.delegationId });
    expect(twice.body['code']).toBe('DELEGATION_NOT_LIVE');
    expect(await heldOn(work.envelopeId)).toBe(before - work.heldMinor);
  });

  it('(b) grant.revoke of the delegating person’s only write grant classifies their attempt', async () => {
    const { member, writeId } = await approverWithGrants('approver_one');
    const lost = await pickedUp('auth_loss_grant', member);
    // The manager's own attempt draws on the manager's grants and must not move.
    const bystander = await pickedUp('auth_loss_bystander');
    const before = await heldOn(lost.envelopeId);

    const revoked = await c.asPerson('grant.revoke', { grantId: writeId });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    expect(await reservation(lost.reservationId)).toEqual({
      state: 'abandoned',
      cause: 'authority_revoked',
      cause_id: lost.delegationId,
    });
    expect(await leaseState(lost.leaseId)).toBe('released');
    expect(await delegationRevoked(lost.delegationId)).toBe(true);
    expect(await heldOn(lost.envelopeId)).toBe(before - lost.heldMinor);

    expect((await reservation(bystander.reservationId)).state).toBe('held');
    expect(await leaseState(bystander.leaseId)).toBe('live');
    expect(await delegationRevoked(bystander.delegationId)).toBe(false);
  });

  it('(b) grant.revoke leaves an attempt whose person still holds write on the task', async () => {
    const { member, writeId } = await approverWithGrants('approver_two');
    const kept = await pickedUp('auth_kept_grant', member);
    // A second, record-scoped write on the same task: revoking the business
    // grant narrows the person, and this attempt's authority survives it.
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, member, 'write', { kind: 'record', id: kept.taskId });
    });
    const before = await heldOn(kept.envelopeId);

    const revoked = await c.asPerson('grant.revoke', { grantId: writeId });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    expect((await reservation(kept.reservationId)).state).toBe('held');
    expect(await leaseState(kept.leaseId)).toBe('live');
    expect(await delegationRevoked(kept.delegationId)).toBe(false);
    expect(await heldOn(kept.envelopeId)).toBe(before);
  });

  it('(c) replay finds a revocation that committed without its classification, exactly once', async () => {
    const work = await pickedUp('auth_loss_replay');
    const before = await heldOn(work.envelopeId);
    // The shape the old handler left behind: the delegation revoked, the lease
    // still live, the hold still held.
    await c.fixture.db.admin.execute(
      `update public.delegations set revoked_at = now() where id = $1`,
      [work.delegationId],
    );

    const first = await c.fixture.db.app.withBusiness(c.fixture.business, (tx) =>
      replayRecordedTransitions(tx),
    );
    const mine = first.filter((row) => row.reservationId === work.reservationId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.released).toBe(true);
    expect(await reservation(work.reservationId)).toEqual({
      state: 'abandoned',
      cause: 'authority_revoked',
      cause_id: work.delegationId,
    });
    expect(await leaseState(work.leaseId)).toBe('released');
    expect(await heldOn(work.envelopeId)).toBe(before - work.heldMinor);

    const second = await c.fixture.db.app.withBusiness(c.fixture.business, (tx) =>
      replayRecordedTransitions(tx),
    );
    expect(second.filter((row) => row.released)).toEqual([]);
    expect(await heldOn(work.envelopeId)).toBe(before - work.heldMinor);
  });

  it('(d) a marked attempt keeps its full hold as quarantined after revocation', async () => {
    const work = await pickedUp('auth_loss_marked');
    const before = await heldOn(work.envelopeId);
    // An imported or corrupt observation, applied as the owner would find it.
    await c.fixture.db.admin.execute(
      `update public.attempts set observed = true, state = 'quarantined' where id = $1`,
      [work.attemptId],
    );

    const revoked = await c.asPerson('delegation.revoke', { delegationId: work.delegationId });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    expect((await reservation(work.reservationId)).state).toBe('quarantined');
    expect(await leaseState(work.leaseId)).toBe('released');
    expect(await heldOn(work.envelopeId)).toBe(before);
  });

  it('the classifier refuses authority_revoked when no revocation is recorded', async () => {
    const work = await pickedUp('auth_loss_unrecorded');
    const before = await heldOn(work.envelopeId);
    const task = await one<{ cap_id: string; run_id: string; lineage_id: string }>(
      `select env.cap_id::text, run.id::text as run_id, run.lineage_id::text
         from public.reservations res
         join public.task_envelopes env on env.id = res.envelope_id
         join public.planned_runs run on run.id = res.run_id
        where res.id = $1`,
      [work.reservationId],
    );

    const answer = await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      const locks = await acquire(tx, [
        { lockClass: 'cap', id: task.cap_id },
        { lockClass: 'envelope', id: work.envelopeId },
        { lockClass: 'task', id: work.taskId },
        { lockClass: 'run', id: task.run_id },
        { lockClass: 'lineage', id: task.lineage_id },
        { lockClass: 'lease', id: work.leaseId },
        { lockClass: 'delegation', id: work.delegationId },
        { lockClass: 'reservation', id: work.reservationId },
      ]);
      return await classifyUnderLocks(
        tx,
        {
          reservationId: work.reservationId,
          cause: 'authority_revoked',
          causeId: work.delegationId,
        },
        locks,
      );
    });
    expect(answer.released).toBe(false);
    expect(answer.state).toBe('held');
    expect(answer.reason).toMatch(/revo/u);
    expect((await reservation(work.reservationId)).state).toBe('held');
    expect(await heldOn(work.envelopeId)).toBe(before);
  });
});
