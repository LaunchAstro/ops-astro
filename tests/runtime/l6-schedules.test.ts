// SPDX-License-Identifier: AGPL-3.0-only
//
// L6 W02 (b) and W04: pickup against itself, against `task.cancel` and against
// an expired-lease replacement, each racer on a backend of its own and each
// interleaving forced and observed (see `schedules-harness.ts`).
//
// - **W02 (b).** The original pickup and a retry under the same operationId,
//   in flight together. Before, `pickup-replay-lost-response.test.ts` retried
//   only after the original had committed. One lease, one delegation, one hold,
//   and both answers carry the same handles.
// - **W04, pickup x cancel.** Both orders. Whichever the server serves first,
//   the reservation has one outcome, its hold is classified at most once and
//   no reservation is revived for a cancelled lineage.
// - **W04, pickup x expired-lease replacement.** Two pickups of a reservation
//   whose lease has lapsed. One replaces it; the other is refused. The old hold
//   is classified once and the abandoned row is never revived.
//
// A third connection holds the cap row every one of these takes first. The
// first racer is seen parked on it, the second is seen waiting on a lock of
// its own, and only then does the holder let go.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import {
  approve,
  asAgent,
  asPerson,
  awaitParked,
  codeOf,
  createTask,
  freshPurpose,
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

if (serverUrl === undefined) {
  console.warn(
    'runtime/l6-schedules: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const MAXIMUM = 2_000;

interface Approved {
  readonly taskId: string;
  readonly proposal: Detail;
  readonly reservationId: string;
}

/** A racer that had to answer. */
function answered(result: PromiseSettledResult<CommandResult>): CommandResult {
  expect(result.status, reasonOf(result)).toBe('fulfilled');
  return (result as PromiseFulfilledResult<CommandResult>).value;
}

/**
 * A racer the product may fault rather than answer, because what it read
 * before its locks changed under them. The fault is a rollback: at HTTP it
 * is `SERVICE_UNAVAILABLE` with a retry fix (`apps/api/server.ts`, `onError`).
 * Anything else is not this fault, and fails here.
 */
function faultedWith(result: PromiseSettledResult<CommandResult>, message: string): boolean {
  if (result.status === 'fulfilled') return false;
  expect(reasonOf(result)).toContain(message);
  return true;
}

const pickupBody = (reservationId: string, operationId: string = randomUUID()): Body => ({
  command: 'task.pickup',
  operationId,
  reservationId,
  leaseSeconds: 600,
});

const cancelBody = (work: Approved): Body => ({
  command: 'task.cancel',
  operationId: randomUUID(),
  recordId: work.taskId,
  lineageId: work.proposal['lineageId'],
  reason: 'the client withdrew the request',
});

const handles = (result: CommandResult): Detail => (result as { detail: Detail }).detail;

describe.skipIf(serverUrl === undefined)('L6 schedules: W02 (b) and W04', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('l6_sched', 1_000_000);
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  async function approved(title: string): Promise<Approved> {
    const taskId = await createTask(s, title);
    const proposal = await propose(s, taskId, { maximumMinor: MAXIMUM, purpose: freshPurpose() });
    const decision = await approve(s, proposal);
    return { taskId, proposal, reservationId: String(decision['reservationId']) };
  }

  /** Backends in this database waiting on any lock: the second racer, seen parked. */
  async function awaitWaiting(count: number): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const waiting = await scalar(
        s,
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
        [],
      );
      if (waiting >= count) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    throw new Error(
      `fewer than ${String(count)} backends ever waited: no schedule was established`,
    );
  }

  /**
   * Two bodies raced in the order given: the first is seen parked on the cap
   * row, the second is seen waiting too, then the holder lets go.
   */
  async function race(
    first: (database: ReturnType<typeof racer>) => Promise<CommandResult>,
    second: (database: ReturnType<typeof racer>) => Promise<CommandResult>,
  ): Promise<readonly [PromiseSettledResult<CommandResult>, PromiseSettledResult<CommandResult>]> {
    const firstDb = racer(s);
    const secondDb = racer(s);
    const holder = await holdRows(s, 'budget_caps', [s.capId]);
    let settled: readonly PromiseSettledResult<CommandResult>[] = [];
    try {
      const one = first(firstDb);
      await awaitParked(s, 'budget_caps', 1);
      const two = second(secondDb);
      await awaitWaiting(2);
      await holder.release();
      settled = await settle([one, two]);
    } finally {
      await holder.release().catch(() => null);
      await firstDb.close();
      await secondDb.close();
    }
    const [a, b] = settled;
    return [a!, b!];
  }

  const count = async (text: string, parameters: readonly unknown[]): Promise<number> =>
    await scalar(s, text, [s.business, ...parameters]);

  const leasesOn = async (taskId: string, state?: string): Promise<number> =>
    await count(
      `select count(*)::text as n from public.leases
        where business_id = $1 and task_id = $2 ${state === undefined ? '' : 'and state = $3'}`,
      state === undefined ? [taskId] : [taskId, state],
    );

  const delegationsFor = async (taskId: string): Promise<number> =>
    await count(
      `select count(distinct l.delegation_id)::text as n from public.leases l
        where l.business_id = $1 and l.task_id = $2`,
      [taskId],
    );

  interface Hold {
    readonly id: string;
    readonly state: string;
    readonly cause: string | null;
    readonly held: string;
  }

  const holdsOf = async (proposal: Detail): Promise<readonly Hold[]> =>
    await rows<Hold>(
      s,
      `select id, state, classified_cause as cause, held_minor::text as held
         from public.reservations where business_id = $1 and version_id = $2
        order by created_at, id`,
      [s.business, proposal['versionId']],
    );

  /** The envelope's held total is the sum of the holds still held: nothing released twice. */
  async function heldIsExact(taskId: string): Promise<void> {
    const found = await rows<{ readonly envelope: string; readonly holds: string }>(
      s,
      `select e.held_minor::text as envelope,
              coalesce((select sum(r.held_minor) from public.reservations r
                         where r.business_id = e.business_id and r.envelope_id = e.id
                           and r.state = 'held'), 0)::text as holds
         from public.task_envelopes e where e.business_id = $1 and e.task_id = $2`,
      [s.business, taskId],
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.envelope).toBe(found[0]?.holds);
  }

  it('W02 (b): the original pickup and its same-operationId retry make one claim with one set of handles', async () => {
    const work = await approved('a pickup retried while the original is in flight');
    const body = pickupBody(work.reservationId);
    const [first, second] = await race(
      async (database) => await asAgent(s, body, undefined, database),
      async (database) => await asAgent(s, body, undefined, database),
    );
    const original = answered(first);
    expect(codeOf(original)).toBe('applied');
    // The retry in flight behind the original loses the operation-identity
    // claim once, and the agent entry's one bounded retry (as the person
    // entry's, `envelope.ts` `executeCommand`) reads the committed row and
    // replays it: no fault reaches the caller (DB-PROOF-GAPS-B F1).
    expect(faultedWith(second, 'operations_identity_key')).toBe(false);
    const retry = answered(second);
    expect(codeOf(retry)).toBe('applied');
    expect(handles(retry)).toStrictEqual(handles(original));
    expect(handles(original)['credential']).toBeTypeOf('string');

    expect(await leasesOn(work.taskId)).toBe(1);
    expect(await leasesOn(work.taskId, 'live')).toBe(1);
    expect(await delegationsFor(work.taskId)).toBe(1);
    expect(
      await count(
        `select count(*)::text as n from public.delegations
          where business_id = $1 and id = $2 and revoked_at is null and settled_at is null`,
        [handles(original)['delegationId']],
      ),
    ).toBe(1);
    const holds = await holdsOf(work.proposal);
    expect(holds.map((hold) => hold.state)).toStrictEqual(['held']);
    expect(holds[0]?.id).toBe(work.reservationId);
    await heldIsExact(work.taskId);
    expect(
      await count(
        `select count(*)::text as n from public.audit_events
          where business_id = $1 and operation_id = $2 and outcome = 'applied'`,
        [body['operationId']],
      ),
    ).toBe(1);
  }, 60_000);

  it('W04: pickup served before task.cancel: the claim is taken, then cancelled and released once', async () => {
    const work = await approved('a pickup that wins the race with a cancel');
    const cancel = cancelBody(work);
    const [first, second] = await race(
      async (database) => await asAgent(s, pickupBody(work.reservationId), undefined, database),
      async (database) => await asPerson(s, cancel, database),
    );
    expect(codeOf(answered(first))).toBe('applied');
    // The cancel discovered an unleased hold before its locks and meets a live
    // lease under them. It rolls back rather than extend its lock set
    // (`recovery.ts`, `AffectedSetChanged`), writing nothing, and the person
    // entry retries it once in a fresh transaction that rediscovers the lease
    // and cancels it (`register-store.ts`, `isRetryableViolation`). The first
    // request answers; the caller never sees the rollback.
    expect(codeOf(answered(second))).toBe('applied');

    const holds = await holdsOf(work.proposal);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ id: work.reservationId, state: 'abandoned' });
    expect(holds[0]?.cause).toBe('lineage_cancelled');
    await heldIsExact(work.taskId);
    expect(await leasesOn(work.taskId)).toBe(1);
    expect(await leasesOn(work.taskId, 'live')).toBe(0);
    expect(
      await count(
        `select count(*)::text as n from public.proposal_lineages
          where business_id = $1 and id = $2 and state = 'cancelled'`,
        [work.proposal['lineageId']],
      ),
    ).toBe(1);

    // Not revived afterwards either.
    expect(codeOf(await asAgent(s, pickupBody(work.reservationId)))).toBe(
      'RESERVATION_NOT_CLAIMABLE',
    );
    expect(await holdsOf(work.proposal)).toStrictEqual(holds);
  }, 60_000);

  it('W04: task.cancel served before pickup: the pickup is refused and nothing is claimed', async () => {
    const work = await approved('a cancel that wins the race with a pickup');
    const [first, second] = await race(
      async (database) => await asPerson(s, cancelBody(work), database),
      async (database) => await asAgent(s, pickupBody(work.reservationId), undefined, database),
    );
    const cancelled = answered(first);
    const picked = answered(second);
    expect(codeOf(cancelled)).toBe('applied');
    expect(codeOf(picked)).toBe('RESERVATION_NOT_CLAIMABLE');

    const holds = await holdsOf(work.proposal);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ id: work.reservationId, state: 'abandoned' });
    expect(holds[0]?.cause).toBe('lineage_cancelled');
    await heldIsExact(work.taskId);
    expect(await leasesOn(work.taskId)).toBe(0);
    expect(await delegationsFor(work.taskId)).toBe(0);
  }, 60_000);

  it('W04: two pickups over an expired lease: one replacement, one refusal, the old hold classified once', async () => {
    const work = await approved('a lapsed lease two claimants race to replace');
    const first = await pickup(s, work.reservationId);
    // The server's clock, moved by the server: the lease and the delegation
    // it was issued with lapse together, as they would in time.
    await s.db.admin.execute(
      `update public.leases set expires_at = now() - interval '1 second' where id = $1`,
      [first['leaseId']],
    );
    await s.db.admin.execute(
      `update public.delegations
          set granted_at = now() - interval '3 seconds', expires_at = now() - interval '1 second'
        where id = $1`,
      [first['delegationId']],
    );

    const settled = await race(
      async (database) => await asAgent(s, pickupBody(work.reservationId), undefined, database),
      async (database) => await asAgent(s, pickupBody(work.reservationId), undefined, database),
    );
    const left = answered(settled[0]);
    const right = answered(settled[1]);
    const codes = [codeOf(left), codeOf(right)];
    expect(codes).toStrictEqual(['applied', 'RESERVATION_NOT_CLAIMABLE']);
    const replaced = handles(left);
    expect(replaced['reservationId']).not.toBe(work.reservationId);

    const holds = await holdsOf(work.proposal);
    expect(holds.map((hold) => [hold.id, hold.state, hold.cause])).toStrictEqual([
      [work.reservationId, 'abandoned', 'lease_expired_and_fenced'],
      [replaced['reservationId'], 'held', null],
    ]);
    await heldIsExact(work.taskId);
    expect(await leasesOn(work.taskId)).toBe(2);
    expect(await leasesOn(work.taskId, 'live')).toBe(1);
    expect(
      await count(
        `select count(*)::text as n from public.leases
          where business_id = $1 and id = $2 and state = 'expired'`,
        [first['leaseId']],
      ),
    ).toBe(1);
  }, 60_000);
});
