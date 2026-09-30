// SPDX-License-Identifier: AGPL-3.0-only
//
// T3f, two lease and money edges, against a real database.
//
// - T3-N10: a nested attempt (a hand-back's successor) against a parent whose
//   cap is exhausted is refused `SUCCESSOR_OUT_OF_BOUNDS`, and the parent's
//   cap, envelope and hold are untouched. `successor-bounds-edge.test.ts`
//   holds one past the room; this is no room at all.
// - T3-N11: a silent run, picked up and dispatched and never renewed, stays
//   running until its lease expires: the pass leaves its lease live and its
//   hold held while the lease has time, and fences the lease and holds the
//   step unknown only once it has run out.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { handbackFootprint, successorBody } from './handback-footprint.ts';
import {
  asAgent,
  capCommitted,
  codeOf,
  handbackBody,
  liveWork,
  openSchedules,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { t2dHarness, type Work } from './t2d-harness.ts';
import { t3bHarness } from './t3b-harness.ts';

const url = databaseUrlFromEnvironment();

if (url === undefined) {
  console.warn('runtime/t3f-lease-edges: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(url === undefined)('T3f nested attempt on an exhausted parent', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('t3fnest', 10);
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('refuses a successor of any size when the parent cap has no room, and moves nothing', async () => {
    const { picked } = await liveWork(s, 'the parent that spent the cap', 10);
    expect(await capCommitted(s)).toBe(10);
    const before = await handbackFootprint(s, picked['leaseId']);
    const refused = await asAgent(
      s,
      handbackBody(picked, successorBody(1)),
      String(picked['credential']),
    );
    expect(codeOf(refused)).toBe('SUCCESSOR_OUT_OF_BOUNDS');
    expect(await handbackFootprint(s, picked['leaseId'])).toStrictEqual(before);
    expect(await capCommitted(s)).toBe(10);
  }, 60_000);
});

describe.skipIf(url === undefined)('T3f a silent run', { timeout: 60_000 }, () => {
  let s: Schedules;
  const t2d = t2dHarness(() => s);
  const t3b = t3bHarness(() => s);

  const stateOf = async (w: Work) =>
    (
      await rows<Record<string, unknown>>(
        s,
        `select l.state as lease, res.state as hold, att.state as attempt, run.state as run
           from public.leases l
           join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
           join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
           join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
          where l.business_id = $1 and l.id = $2`,
        [s.business, w.picked['leaseId']],
      )
    )[0];

  beforeAll(async () => {
    s = await openSchedules('t3fsilent', 1_000_000);
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  it('stays running until its lease expires, then is fenced and held unknown', async () => {
    const w = await t2d.work();
    await t2d.dispatched(w);
    const running = await stateOf(w);
    expect(running).toMatchObject({ lease: 'live', hold: 'held', attempt: 'dispatched' });

    // No heartbeat, and the pass runs while the lease still has time.
    await t3b.sweep();
    await t3b.sweep();
    expect(await stateOf(w)).toStrictEqual(running);

    await t3b.expire(w);
    await t3b.sweep();
    expect(await stateOf(w)).toMatchObject({
      lease: 'expired',
      hold: 'held',
      attempt: 'liability_unknown',
      run: running?.['run'],
    });
  });
});
