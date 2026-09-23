// SPDX-License-Identifier: AGPL-3.0-only
//
// PERSON-WORK schedules through the production command entry, each racer on a
// backend of its own and each interleaving forced and observed rather than
// slept through (see `schedules-harness.ts`).
//
// - **Grant revocation against pickup** (RUNTIME-LIFECYCLE F4 residual). A
//   pickup that read its authority before `grant.revoke` committed, and that
//   commits after the revocation's locked rediscovery, used to leave a live
//   lease and a live delegation drawing on a grant that no longer exists.
// - **R5, the fresh replacement.** A hold abandoned by authority loss, on work
//   still approved, is claimed again as a new hold and a new attempt; settled
//   work is not.
// - **Competing claimants.** Two people and an agent reach one reservation at
//   once; exactly one holds it.
// - **An agent on a person's lease of its own task.** The delegation's one
//   task ceiling passes, so only the runtime's holder check stands between the
//   agent and the person's work.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asAgent,
  awaitParked,
  codeOf,
  createTask,
  freshPurpose,
  handbackBody,
  holdRows,
  openSchedules,
  pickup,
  propose,
  racer,
  reasonOf,
  rows,
  scalar,
  settle,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('person work schedules', () => {
  let s: Schedules;
  let manager: Member;
  let worker: Member;

  beforeAll(async () => {
    s = await openSchedules('person_work', 1_000_000);
    manager = await enrol(s.db.app, s.business, 'manager');
    worker = await enrol(s.db.app, s.business, 'worker');
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const action of ['read', 'write', 'manage'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, manager, action);
      }
      await grantTo(tx, worker, 'read');
      await grantTo(tx, worker, 'write');
    });
  }, 120_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  // A case that revokes the decider's write puts it back, and a case that
  // failed part-way must not leave the next one without it.
  beforeEach(async () => {
    const live = await scalar(
      s,
      `select count(*)::text as n from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and revoked_at is null`,
      [s.business, s.decider.personId],
    );
    if (live === 0) await regrantDecider();
  });

  async function as(
    member: Member,
    body: Body,
    database: Database = s.db.app,
  ): Promise<CommandResult> {
    return await executeCommand(database, s.business, member.presented, 'api', body as never);
  }

  /** Proposed and approved by the decider: a reservation on the queue. */
  async function approvedWork(title: string): Promise<{ taskId: string; decision: Detail }> {
    const taskId = await createTask(s, title);
    const proposal = await propose(s, taskId, { maximumMinor: 1_000, purpose: freshPurpose() });
    return { taskId, decision: await approve(s, proposal) };
  }

  /** The decider's live write grant, the one an agent's delegation draws on. */
  async function deciderWrite(): Promise<string> {
    const found = await rows<{ readonly id: string }>(
      s,
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and revoked_at is null`,
      [s.business, s.decider.personId],
    );
    return String(found[0]?.id);
  }

  async function revoke(grantId: string, database: Database = s.db.app): Promise<CommandResult> {
    return await as(
      manager,
      { command: 'grant.revoke', operationId: randomUUID(), grantId },
      database,
    );
  }

  async function regrantDecider(): Promise<void> {
    await s.db.app.withBusiness(s.business, async (tx) => {
      await grantTo(tx, s.decider, 'write', undefined, true);
    });
  }

  /** Live leases on the task whose delegation is also still live. */
  async function liveDelegatedLeases(taskId: string): Promise<number> {
    return await scalar(
      s,
      `select count(*)::text as n from public.leases l
         join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
        where l.business_id = $1 and l.task_id = $2 and l.state = 'live'
          and d.revoked_at is null and d.settled_at is null`,
      [s.business, taskId],
    );
  }

  it('serialises grant.revoke with a pickup that has already read the grant', async () => {
    const work = await approvedWork('revocation races a pickup');
    const reservationId = String(work.decision['reservationId']);
    const attempt = await rows<{ readonly id: string }>(
      s,
      `select id from public.attempts where business_id = $1 and reservation_id = $2`,
      [s.business, reservationId],
    );
    const grantId = await deciderWrite();

    // The pickup parks on the attempt row it updates after minting: it has
    // read and used the decider's grant, and it has not committed.
    const holder = await holdRows(s, 'attempts', [String(attempt[0]?.id)]);
    const pickupDb = racer(s);
    const revokeDb = racer(s);
    let pickedUp: Promise<CommandResult> | undefined;
    let revoked: Promise<CommandResult> | undefined;
    try {
      pickedUp = asAgent(
        s,
        { command: 'task.pickup', operationId: randomUUID(), reservationId, leaseSeconds: 600 },
        undefined,
        pickupDb,
      );
      await awaitParked(s, 'attempts', 1);
      revoked = revoke(grantId, revokeDb);
      // The revocation must wait for the pickup's grant lock. Before the fix it
      // committed straight past it; either way the answer is observed, not slept.
      const outcome = await Promise.race([
        revoked.then(() => 'committed'),
        awaitParked(s, 'grants', 1).then(
          () => 'parked',
          () => 'never parked',
        ),
      ]);
      expect(outcome).toBe('parked');
    } finally {
      await holder.release();
    }
    const settled = await settle([
      pickedUp as Promise<CommandResult>,
      revoked as Promise<CommandResult>,
    ]);
    await pickupDb.close();
    await revokeDb.close();
    for (const each of settled) expect(each.status, reasonOf(each)).toBe('fulfilled');
    const [picked, revocation] = settled as PromiseFulfilledResult<CommandResult>[];
    expect(codeOf(revocation!.value)).toBe('applied');

    // Whichever order the server served, no live claim draws on the revoked grant.
    expect(await liveDelegatedLeases(work.taskId), codeOf(picked!.value)).toBe(0);
  }, 60_000);

  it('claims a fresh hold for approved work whose hold was abandoned by authority loss (R5)', async () => {
    const work = await approvedWork('authority lost, then restored');
    const oldReservation = String(work.decision['reservationId']);
    const first = await pickup(s, oldReservation);
    expect(codeOf(await revoke(await deciderWrite()))).toBe('applied');
    expect(
      await scalar(
        s,
        `select count(*)::text as n from public.reservations
          where business_id = $1 and id = $2 and state = 'abandoned'`,
        [s.business, oldReservation],
      ),
    ).toBe(1);
    await regrantDecider();

    const again = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: oldReservation,
      leaseSeconds: 600,
    });
    const replaced = appliedDetail(again, 'task.pickup after authority loss');
    expect(replaced['reservationId']).not.toBe(oldReservation);
    expect(replaced['attemptId']).not.toBe(first['attemptId']);
    expect(replaced['fence']).toBe(Number(first['fence']) + 1);
    // The abandoned hold is not revived.
    expect(
      await scalar(
        s,
        `select count(*)::text as n from public.reservations
          where business_id = $1 and id = $2 and state = 'abandoned'`,
        [s.business, oldReservation],
      ),
    ).toBe(1);

    // Settled work is never replaced: after the handback, the same id is refused.
    appliedDetail(
      await asAgent(s, handbackBody(replaced), String(replaced['credential'])),
      'task.handback',
    );
    const afterSettled = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: replaced['reservationId'],
    });
    expect(codeOf(afterSettled)).toBe('RESERVATION_NOT_CLAIMABLE');
  });

  it('gives one reservation to exactly one of two people and an agent racing for it', async () => {
    const work = await approvedWork('three claimants, one claim');
    const reservationId = String(work.decision['reservationId']);
    // The cap is the first lock every claimant takes, so all three queue on it
    // in the order they arrive, and the server serves them in that order.
    const holder = await holdRows(s, 'budget_caps', [s.capId]);
    const dbs = [racer(s), racer(s), racer(s)];
    const body = (): Body => ({ command: 'task.pickup', operationId: randomUUID(), reservationId });
    const racers: Promise<CommandResult>[] = [];
    try {
      racers.push(as(s.decider, body(), dbs[0]));
      await awaitParked(s, 'budget_caps', 1);
      racers.push(as(worker, body(), dbs[1]));
      await awaitParked(s, 'budget_caps', 2);
      racers.push(asAgent(s, body(), undefined, dbs[2]));
      await awaitParked(s, 'budget_caps', 3);
    } finally {
      await holder.release();
    }
    const settled = await settle(racers);
    await Promise.all(dbs.map(async (db) => await db.close()));
    const codes = settled.map((each) =>
      each.status === 'fulfilled' ? codeOf(each.value) : reasonOf(each),
    );
    expect(codes).toStrictEqual([
      'applied',
      'RESERVATION_NOT_CLAIMABLE',
      'RESERVATION_NOT_CLAIMABLE',
    ]);
    expect(
      await scalar(
        s,
        `select count(*)::text as n from public.leases where business_id = $1 and task_id = $2`,
        [s.business, work.taskId],
      ),
    ).toBe(1);
  }, 60_000);

  it("refuses an agent on a person's lease of the agent's own task, and writes nothing", async () => {
    const work = await approvedWork('the agent lapses, the person takes over');
    const reservationId = String(work.decision['reservationId']);
    const agentClaim = await pickup(s, reservationId);
    // The agent's lease lapses; its delegation is left live on purpose, so the
    // one-task ceiling passes and only the runtime's holder check is tested.
    await s.db.admin.execute(
      `update public.leases set expires_at = now() - interval '1 second' where id = $1`,
      [agentClaim['leaseId']],
    );
    const personClaim = appliedDetail(
      await as(worker, { command: 'task.pickup', operationId: randomUUID(), reservationId }),
      'person pickup over an expired agent lease',
    );
    expect(personClaim['claimant']).toBe('person');
    expect(personClaim['fence']).toBe(2);

    const credential = String(agentClaim['credential']);
    const beat = await asAgent(
      s,
      {
        command: 'task.heartbeat',
        operationId: randomUUID(),
        leaseId: personClaim['leaseId'],
        fence: personClaim['fence'],
      },
      credential,
    );
    expect(codeOf(beat)).toBe('LEASE_NOT_OWNED');
    const handedBack = await asAgent(s, handbackBody(personClaim), credential);
    expect(codeOf(handedBack)).toBe('LEASE_NOT_OWNED');
    expect(
      await scalar(
        s,
        `select count(*)::text as n from public.handback_reports
          where business_id = $1 and lease_id = $2`,
        [s.business, personClaim['leaseId']],
      ),
    ).toBe(0);

    // The person's own handback still settles it.
    appliedDetail(
      await as(worker, {
        command: 'task.handback',
        operationId: randomUUID(),
        leaseId: personClaim['leaseId'],
        fence: personClaim['fence'],
        outcome: 'completed',
      }),
      'the person hands back their own lease',
    );
  });
});
