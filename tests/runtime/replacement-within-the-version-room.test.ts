// SPDX-License-Identifier: AGPL-3.0-only
//
// A replacement hold is sized by what its old hold had left, and never past
// what the version has left of its approved ceiling. Rows written before
// replacements were stamped at insertion can carry a replacement whose
// created_at sorts before its predecessor's, so the predecessor reads as the
// newest hold. Picking it up must still keep the version inside its ceiling:
// its spend and every hold still live count against it, under the run lock.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { raiseBudgetWait } from '../../packages/core-custody/src/index.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  capCommitted,
  codeOf,
  liveWork,
  openSchedules,
  pickup,
  rows,
  type Detail,
  type Schedules,
  type Work,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/replacement-within-the-version-room: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('replacement_room', 1_000_000);
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'manage');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'billing');
    await installBusinessSettings(tx);
  });
}, 180_000);

afterAll(async () => {
  await s?.db.drop();
});

/** A model call on the hold, settled at `minor`, as the broker records one. */
async function spend(reservationId: unknown, minor: number): Promise<void> {
  await s.db.admin.execute(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
        route_key, route_reach, credential_kind, state, reserved_minor, observed_minor,
        actual_minor, ended_at)
     select r.business_id, $2, r.run_id, a.step_id, r.lease_id, r.version_id, r.id,
            'replacement_room_spend', 'replay', 'local', 'replay', 'settled', $3, $3, $3,
            clock_timestamp()
       from public.reservations r
       join public.attempts a on a.business_id = r.business_id and a.reservation_id = r.id
      where r.id = $1`,
    [reservationId, randomUUID(), minor],
  );
}

/** A manager revokes the worker's delegation: the hold is classified at its calls' spend. */
async function stopWorker(picked: Detail): Promise<void> {
  const revoked = await asPerson(s, {
    command: 'delegation.revoke',
    operationId: randomUUID(),
    delegationId: picked['delegationId'],
  });
  appliedDetail(revoked, 'delegation.revoke');
}

interface Hold {
  readonly id: string;
  readonly state: string;
  readonly held: string;
  readonly actual: string | null;
}

async function holdsOf(versionId: unknown): Promise<readonly Hold[]> {
  return await rows<Hold>(
    s,
    `select id, state, held_minor::text as held, actual_minor::text as actual
       from public.reservations where business_id = $1 and version_id = $2
      order by created_at, id`,
    [s.business, versionId],
  );
}

/** The historical state: `later` stamped one second before `earlier`. */
async function stampBefore(earlier: unknown, later: unknown): Promise<void> {
  await s.db.admin.execute(
    `update public.reservations set created_at = (
       select created_at - interval '1 second' from public.reservations
        where business_id = $1 and id = $2)
      where business_id = $1 and id = $3`,
    [s.business, earlier, later],
  );
}

/** Live work on a 500 version, its envelope raised to 1000 so only the version bounds a hold. */
async function roomyWork(): Promise<{ work: Work; versionId: unknown; first: unknown }> {
  const work = await liveWork(s, `replacement room ${randomUUID()}`, 500);
  await s.db.admin.execute(
    `update public.task_envelopes set maximum_minor = 1000
      where business_id = $1 and task_id = $2`,
    [s.business, work.taskId],
  );
  return { work, versionId: work.proposal['versionId'], first: work.decision['reservationId'] };
}

/**
 * AW-05's stop and top-up on the first hold: a call reaching its ceiling stops
 * the run with the hold kept, and the person tops it up by `amount`. The
 * top-up moves the hold's spend to the envelope's actual and leaves the hold
 * held at its ceiling plus the amount less that spend.
 */
async function stopAndTopUp(work: Work, reservationId: unknown, amount: number): Promise<void> {
  const [hold] = await rows<{ run_id: string; spent: string }>(
    s,
    `select r.run_id, (select coalesce(sum(c.actual_minor), 0) from public.model_calls c
                        where c.business_id = r.business_id and c.reservation_id = r.id)::text as spent
       from public.reservations r where r.business_id = $1 and r.id = $2`,
    [s.business, reservationId],
  );
  if (hold === undefined) throw new Error('stopAndTopUp: no hold');
  await s.db.app.withBusiness(s.business, async (tx) => {
    const wait = await raiseBudgetWait(tx, {
      runId: hold.run_id,
      leaseId: String(work.picked['leaseId']),
      delegationId: String(work.picked['delegationId']),
      reservationId: String(reservationId),
      versionId: String(work.proposal['versionId']),
      ceilingMinor: 500,
      spentMinor: Number(hold.spent),
    });
    if (!wait.raised) throw new Error('stopAndTopUp: no ask raised');
  });
  const [ask] = await rows<{ id: string }>(
    s,
    'select id from public.budget_asks where business_id = $1 and run_id = $2',
    [s.business, hold.run_id],
  );
  const topped = await asPerson(s, {
    command: 'run.top_up',
    operationId: randomUUID(),
    recordId: work.taskId,
    runId: hold.run_id,
    askId: ask?.id,
    amountMinor: amount,
    currency: 'AUD',
  });
  appliedDetail(topped, 'run.top_up');
}

/** The money a refusal must leave alone: every hold, the envelope and the cap. */
async function moneyOf(work: Work, versionId: unknown): Promise<unknown> {
  const envelope = await rows(
    s,
    `select maximum_minor::text as maximum, held_minor::text as held, actual_minor::text as actual
       from public.task_envelopes where business_id = $1 and task_id = $2`,
    [s.business, work.taskId],
  );
  return { holds: await holdsOf(versionId), envelope, cap: await capCommitted(s) };
}

/** What the version has committed: its active holds whole, and its closed ones at their spend. */
const committed = (holds: readonly Hold[]): number =>
  holds.reduce(
    (sum, hold) =>
      sum +
      (['held', 'quarantined'].includes(hold.state) ? Number(hold.held) : Number(hold.actual ?? 0)),
    0,
  );

describe.skipIf(serverUrl === undefined)('a replacement holds within the version room', () => {
  it("holds only the version's remaining 300 when a replacement's timestamp sorts before its predecessor's, and the version never commits past its 500", async () => {
    const work = await liveWork(s, `replacement room ${randomUUID()}`, 500);
    const versionId = work.proposal['versionId'];
    const first = work.decision['reservationId'];
    await s.db.admin.execute(
      `update public.task_envelopes set maximum_minor = 1000
        where business_id = $1 and task_id = $2`,
      [s.business, work.taskId],
    );
    await spend(first, 100);
    await stopWorker(work.picked);
    const second = await pickup(s, first);
    await spend(second['reservationId'], 100);
    await stopWorker(second);
    // The historical state: the replacement stamped before its predecessor.
    await stampBefore(first, second['reservationId']);

    const again = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: first,
      leaseSeconds: 600,
    });
    const holds = await holdsOf(versionId);
    const live = holds.filter((hold) => hold.state === 'held').map((hold) => hold.held);
    expect({ code: codeOf(again), live, committed: committed(holds) }).toEqual({
      code: 'applied',
      live: ['300'],
      committed: 500,
    });
  });

  it('counts the spend a top-up moved off a held hold, so a replacement sorted before it leaves the version at its approved 600', async () => {
    const { work, versionId, first } = await roomyWork();
    await spend(first, 100);
    // Stopped at its ceiling and topped up by 100: the hold stays held at
    // 500 + 100 - 100, and the 100 spent moves to the envelope's actual.
    await stopAndTopUp(work, first, 100);
    // The pickup after the top-up replaces the hold with one held at 500.
    const second = await pickup(s, first);
    await spend(second['reservationId'], 100);
    await stopWorker(second);
    await stampBefore(first, second['reservationId']);

    const again = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: first,
      leaseSeconds: 600,
    });
    const holds = await holdsOf(versionId);
    const live = holds.filter((hold) => hold.state === 'held').map((hold) => hold.held);
    // The spend the top-up moved to the envelope's actual: the first hold's calls.
    const [moved] = await rows<{ minor: string }>(
      s,
      `select coalesce(sum(actual_minor), 0)::text as minor from public.model_calls
        where business_id = $1 and reservation_id = $2 and state = 'settled'`,
      [s.business, first],
    );
    expect({
      code: codeOf(again),
      live,
      committed: Number(moved?.minor) + committed(holds),
    }).toEqual({
      code: 'applied',
      live: ['400'],
      committed: 600,
    });
  });

  it('stops the run at its budget and asks once when the version has no room left, moving no money', async () => {
    const { work, versionId, first } = await roomyWork();
    await spend(first, 100);
    await stopWorker(work.picked);
    const second = await pickup(s, first);
    await spend(second['reservationId'], 400);
    await stopWorker(second);
    await stampBefore(first, second['reservationId']);
    const [run] = await rows<{ run_id: string }>(
      s,
      'select run_id from public.reservations where business_id = $1 and id = $2',
      [s.business, first],
    );
    const before = await moneyOf(work, versionId);

    const again = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: first,
      leaseSeconds: 600,
    });
    const asks = await rows(
      s,
      'select reservation_id from public.budget_asks where business_id = $1 and run_id = $2',
      [s.business, run?.run_id],
    );
    expect({ code: codeOf(again), asks, money: await moneyOf(work, versionId) }).toEqual({
      code: 'BUDGET_UNAVAILABLE',
      asks: [{ reservation_id: first }],
      money: before,
    });
  });
});
