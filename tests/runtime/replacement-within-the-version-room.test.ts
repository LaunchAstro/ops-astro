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
    'runtime/replacement-within-the-version-room: DATABASE_URL is unset, so nothing below ran.',
  );
}

let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('replacement_room', 1_000_000);
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
    await s.db.admin.execute(
      `update public.reservations set created_at = (
         select created_at - interval '1 second' from public.reservations
          where business_id = $1 and id = $2)
        where business_id = $1 and id = $3`,
      [s.business, first, second['reservationId']],
    );

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
});
