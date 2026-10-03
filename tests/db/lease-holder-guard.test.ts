// SPDX-License-Identifier: AGPL-3.0-only
//
// A lease's holder is written once, by the pickup path (`20261002235700_lease_pickup_path`).
// 0111 refuses a reviewed output its lease's holder did not propose, which is
// only as strong as the holder column: while the application role could
// update `leases.holder_actor_id` or insert a lease of its own, it could name
// any actor the holder. The application role now updates only the columns the
// product moves (`expires_at`, `state`, `released_at`) and inserts no lease;
// a lease is taken through `public.take_lease`, which pickup calls.
//
// The refusals are written straight through the application role, with no
// code path in front of them. The controls are the product's own paths: an
// agent's and a person's pickup, a heartbeat, a hand-back and a fence.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  asPerson,
  handbackBody,
  liveWork,
  openSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { approvedWork, asApp, leaseRow, personPickup } from './lease-guard-support.ts';

const serverUrl = databaseUrlFromEnvironment();
const DENIED = {
  accepted: false,
  code: '42501',
  message: expect.stringMatching(/permission denied/u),
};

// eslint-disable-next-line max-lines-per-function -- four cases over one world
describe.skipIf(serverUrl === undefined)('a lease names the holder its pickup took it for', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('lease_guard', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it("the app role cannot change a lease's holder", async () => {
    const work = await liveWork(s, `holder ${randomUUID()}`, 2_000);
    const leaseId = work.picked['leaseId'];
    const where = 'where business_id = $1 and id = $2';

    const rewritten = await asApp(
      s,
      s.business,
      `update public.leases set holder_actor_id = $3 ${where} returning 1`,
      [s.business, leaseId, s.decider.actorId],
    );
    expect(rewritten).toMatchObject(DENIED);
    expect((await leaseRow(s, leaseId))['holder_actor_id']).toBe(s.agentActorId);

    // Control: the columns the product moves are still the application's to move.
    for (const column of ['expires_at', 'state', 'released_at']) {
      // One at a time: each is its own rolled-back transaction on the owner's connection.
      // oxlint-disable-next-line no-await-in-loop
      const moved = await asApp(
        s,
        s.business,
        `update public.leases set ${column} = ${column} ${where} returning 1`,
        [s.business, leaseId],
      );
      expect(moved, column).toStrictEqual({ accepted: true, rows: [{ '?column?': 1 }] });
    }
  });

  it('the app role cannot insert a lease directly', async () => {
    const work = await liveWork(s, `insert ${randomUUID()}`, 2_000);
    const forged = randomUUID();
    // A copy of a real lease naming the decider as its holder: the row 0111's
    // check would then read as the decider's own work.
    const inserted = await asApp(
      s,
      s.business,
      `insert into public.leases (business_id, id, task_id, run_id, reservation_id,
         holder_actor_id, authorised_by_person_id, fence, state, expires_at, released_at)
       select business_id, $3, task_id, run_id, reservation_id, $4, authorised_by_person_id,
              fence + 1000, 'released', expires_at, now()
         from public.leases where business_id = $1 and id = $2
       returning 1`,
      [s.business, work.picked['leaseId'], forged, s.decider.actorId],
    );
    expect(inserted).toMatchObject(DENIED);
    expect(await leaseRow(s, forged)).toStrictEqual({});
  });

  it('a pickup still takes its lease through the pickup path', async () => {
    const agents = await liveWork(s, `agent pickup ${randomUUID()}`, 2_000);
    expect(await leaseRow(s, agents.picked['leaseId'])).toMatchObject({
      holder_actor_id: s.agentActorId,
      delegation_id: expect.any(String),
      fence: 1,
      state: 'live',
    });

    const persons = await personPickup(s, (await approvedWork(s))['reservationId']);
    expect(persons['claimant']).toBe('person');
    expect(await leaseRow(s, persons['leaseId'])).toMatchObject({
      holder_actor_id: s.decider.actorId,
      delegation_id: null,
      fence: 1,
      state: 'live',
    });
  });

  it('a heartbeat, a hand-back and a fence still update their lease', async () => {
    const approved = await approvedWork(s);
    const picked = await personPickup(s, approved['reservationId']);
    const leaseId = picked['leaseId'];
    const before = (await leaseRow(s, leaseId))['expires_at'] as Date;

    const beat = { leaseId, fence: picked['fence'], leaseSeconds: 1_200 };
    const renewed = await asPerson(s, {
      command: 'task.heartbeat',
      operationId: randomUUID(),
      ...beat,
    });
    appliedDetail(renewed, 'heartbeat');
    const after = (await leaseRow(s, leaseId))['expires_at'] as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());

    appliedDetail(await asPerson(s, handbackBody(picked)), 'hand-back');
    expect((await leaseRow(s, leaseId))['state']).toBe('released');

    // The fence: an expired lease is fenced out by the next pickup of its work.
    const stale = await personPickup(s, (await approvedWork(s))['reservationId']);
    await s.db.admin.execute(
      `update public.leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`,
      [stale['leaseId']],
    );
    const replacement = await personPickup(s, stale['reservationId']);
    expect((await leaseRow(s, stale['leaseId']))['state']).toBe('expired');
    expect(await leaseRow(s, replacement['leaseId'])).toMatchObject({ fence: 2, state: 'live' });
  });
});
