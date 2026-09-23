// SPDX-License-Identifier: AGPL-3.0-only
//
// Own-lease work authorised on the task, not the business (ITEM5 row 8).
//
// Person pickup, renewal and handback each check `write` on the task under
// their locks (`pickup.ts`, `heartbeat.ts`, `handback.ts`), and `grant.revoke`
// counts a record-scoped write as keeping the claim (`authority-controls.ts`).
// The envelope asked the same `write` business-wide, so a person whose write
// covered only the task could not pick it up, and a holder reduced to that
// write kept a live lease they could neither renew nor hand back. The three are
// now asked of the task the reservation or lease names, as `task.cancel` and
// `task.restart` are (LG:37; `control-scope.test.ts`), and nobody is given
// business-wide write to make that pass.
//
// Every call goes through the person route the product serves.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import { createControls, detailOf, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** What a caller can compare: the status and the whole body. */
const shape = (answer: { status: number; body: Record<string, unknown> }): unknown => ({
  status: answer.status,
  body: answer.body,
});

describe.skipIf(serverUrl === undefined)('own-lease work authorised on its task', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('olrs');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  const leaseState = async (id: string): Promise<string> => {
    const rows = await c.fixture.db.admin.execute<{ state: string }>(
      `select state from public.leases where id = $1`,
      [id],
    );
    return rows[0]?.state ?? 'missing';
  };

  /** Proposed and approved by the manager; nobody has picked it up. */
  async function approvedWork(purpose: string): Promise<{ taskId: string; reservationId: string }> {
    const task = await c.createTask(`a task for ${purpose}`);
    const reservationId = await c.approve(await c.propose(task.id, task.revision, purpose));
    return { taskId: task.id, reservationId };
  }

  /** A person holding `read` and `write` on one task and nothing else. */
  async function recordWriter(name: string, taskId: string): Promise<Member> {
    const member = await enrol(c.fixture.db.app, c.fixture.business, name);
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, member, 'read', { kind: 'record', id: taskId });
      await grantTo(tx, member, 'write', { kind: 'record', id: taskId });
    });
    return member;
  }

  it('a record-scoped writer picks up, renews and hands back their own lease', async () => {
    const work = await approvedWork('record_scoped_own_lease');
    const member = await recordWriter('record_writer', work.taskId);

    const picked = await c.asPerson(
      'task.pickup',
      { reservationId: work.reservationId, leaseSeconds: 600 },
      member,
    );
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const lease = detailOf(picked);
    expect(lease['claimant']).toBe('person');

    const renewed = await c.asPerson(
      'task.heartbeat',
      { leaseId: lease['leaseId'], fence: lease['fence'], leaseSeconds: 1_200 },
      member,
    );
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);

    const handedBack = await c.asPerson(
      'task.handback',
      { leaseId: lease['leaseId'], fence: lease['fence'], outcome: 'completed' },
      member,
    );
    expect(handedBack.status, JSON.stringify(handedBack.body)).toBe(200);
    expect(await leaseState(String(lease['leaseId']))).toBe('released');
  });

  it('refuses the sibling task’s reservation and lease exactly as a fabricated id', async () => {
    const mine = await approvedWork('record_scoped_mine');
    const sibling = await approvedWork('record_scoped_sibling');
    const member = await recordWriter('sibling_writer', mine.taskId);
    // The sibling's lease, held by the manager, who writes business-wide.
    const held = await c.asPerson('task.pickup', {
      reservationId: sibling.reservationId,
      leaseSeconds: 600,
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const siblingLease = detailOf(held);

    const fabricated = randomUUID();

    const pickups = await Promise.all(
      [sibling.reservationId, fabricated].map((reservationId) =>
        c.asPerson('task.pickup', { reservationId, leaseSeconds: 600 }, member),
      ),
    );
    expect(pickups[0]?.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(shape(pickups[0]!)).toStrictEqual(shape(pickups[1]!));

    const leaseCalls = await Promise.all(
      (
        [
          ['task.heartbeat', { leaseSeconds: 600 }],
          ['task.handback', { outcome: 'completed' }],
        ] as const
      ).flatMap(([name, extra]) =>
        [siblingLease['leaseId'], fabricated].map((leaseId) =>
          c.asPerson(name, { leaseId, fence: 1, ...extra }, member),
        ),
      ),
    );
    for (const [foreign, made] of [
      [leaseCalls[0], leaseCalls[1]],
      [leaseCalls[2], leaseCalls[3]],
    ]) {
      expect(foreign?.body['code']).toBe('SCOPE_NOT_GRANTED');
      expect(shape(foreign!)).toStrictEqual(shape(made!));
    }
    expect(await leaseState(String(siblingLease['leaseId']))).toBe('live');
  });

  it('a member with no write is still refused before the handler', async () => {
    const work = await approvedWork('record_scoped_no_write');
    const picked = await c.asPerson(
      'task.pickup',
      { reservationId: work.reservationId, leaseSeconds: 600 },
      c.reader,
    );
    expect(picked.body['code']).toBe('SCOPE_NOT_GRANTED');
  });

  it('a holder reduced to record-scoped write renews and hands back the lease revoke kept', async () => {
    const work = await approvedWork('record_scoped_strand');
    const member = await enrol(c.fixture.db.app, c.fixture.business, 'strand_writer');
    let businessWrite = '';
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, member, 'read');
      businessWrite = await grantTo(tx, member, 'write');
      await grantTo(tx, member, 'write', { kind: 'record', id: work.taskId });
    });
    const picked = await c.asPerson(
      'task.pickup',
      { reservationId: work.reservationId, leaseSeconds: 600 },
      member,
    );
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const lease = detailOf(picked);

    const revoked = await c.asPerson('grant.revoke', { grantId: businessWrite });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(detailOf(revoked)['classifiedHolds']).toStrictEqual([]);
    expect(await leaseState(String(lease['leaseId']))).toBe('live');

    const renewed = await c.asPerson(
      'task.heartbeat',
      { leaseId: lease['leaseId'], fence: lease['fence'], leaseSeconds: 1_200 },
      member,
    );
    expect(renewed.status, JSON.stringify(renewed.body)).toBe(200);
    const handedBack = await c.asPerson(
      'task.handback',
      { leaseId: lease['leaseId'], fence: lease['fence'], outcome: 'completed' },
      member,
    );
    expect(handedBack.status, JSON.stringify(handedBack.body)).toBe(200);
    expect(await leaseState(String(lease['leaseId']))).toBe('released');
  });

  it('the agent path keeps its delegation checks', async () => {
    const work = await approvedWork('record_scoped_agent');
    const picked = await c.pickup(work.reservationId);
    const renewed = await c.asAgent(
      'task.heartbeat',
      { leaseId: picked['leaseId'], fence: picked['fence'] },
      'not-a-delegation-credential',
    );
    expect(renewed.status).not.toBe(200);
    expect(await leaseState(String(picked['leaseId']))).toBe('live');
  });
});
