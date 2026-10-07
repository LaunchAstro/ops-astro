// SPDX-License-Identifier: AGPL-3.0-only
//
// A step's work stopped mid-way comes back on a fresh hold of what its last
// hold had left (AW-01). Each replacement is a new reservation, and the older
// ones stay behind as history. Naming an older one again must not hold its
// remainder a second time: the version's approved ceiling already paid for
// the spend on every later hold, so the task envelope having room is no
// reason to hold past it. Only the newest hold of the version and run is
// replaced.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  liveWork,
  openSchedules,
  pickup,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/replacement-from-the-newest-hold: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('replacement_newest', 1_000_000);
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'manage'));
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
            'replacement_spend', 'replay', 'local', 'replay', 'settled', $3, $3, $3,
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

/** What the version has committed: its active holds whole, and its closed ones at their spend. */
const committed = (holds: readonly Hold[]): number =>
  holds.reduce(
    (sum, hold) =>
      sum +
      (['held', 'quarantined'].includes(hold.state) ? Number(hold.held) : Number(hold.actual ?? 0)),
    0,
  );

describe.skipIf(serverUrl === undefined)('a replacement holds from the newest hold only', () => {
  it("refuses to hold an older reservation's remainder again once a later hold spent, and the version never commits past its 500", async () => {
    const work = await liveWork(s, `replacement newest ${randomUUID()}`, 500);
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
    expect((await holdsOf(versionId)).map((hold) => [hold.state, hold.held])).toEqual([
      ['actual', '500'],
      ['held', '400'],
    ]);
    await spend(second['reservationId'], 100);
    await stopWorker(second);

    const again = await asAgent(s, {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: first,
      leaseSeconds: 600,
    });
    const holds = await holdsOf(versionId);
    expect({ code: codeOf(again), committed: committed(holds) }).toEqual({
      code: 'RESERVATION_NOT_CLAIMABLE',
      committed: 200,
    });

    // The newest hold is still the way on, holding what the version has left.
    await pickup(s, second['reservationId']);
    const after = await holdsOf(versionId);
    expect(after.at(-1)).toMatchObject({ state: 'held', held: '300' });
    expect(committed(after)).toBe(500);
  });
});
