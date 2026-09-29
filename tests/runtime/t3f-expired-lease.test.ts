// SPDX-License-Identifier: AGPL-3.0-only
//
// T3f, `expired_lease_money_only` (T3-N2, B22), against a real database.
//
// A worker whose lease ran out after its effect applied still reports what
// the step cost: observe settles that money and marks where it came from
// (`lease: 'expired'`, stored in the register with the answer), and no work
// moves: the lease, the run, the task and the delegation read back as they
// were. Every work transition the same worker then asks for on that lease,
// renewal, a second dispatch or a hand-back, is refused `LEASE_EXPIRED` and
// writes nothing. Red until T2d settles money, and red if any work transition
// comes from an expired lease. Beside it: a live lease's settlement is marked
// `live`, so the mark tells the two apart; the expired lease settles only its
// own business's money, and a worker naming another business's lease is
// refused as not its own.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  codeOf,
  handbackBody,
  openSchedules,
  rows,
  type Schedules,
} from './schedules-harness.ts';
import { PRICED, t2dHarness, type Work } from './t2d-harness.ts';
import { openSecond } from './t3b-harness.ts';

const url = databaseUrlFromEnvironment();

if (url === undefined) {
  console.warn('runtime/t3f-expired-lease: DATABASE_URL is unset, so nothing below ran.');
}

/** Everything a work transition would move, on the work's own rows. */
const workState = async (on: Schedules, w: Work) =>
  await rows<Record<string, unknown>>(
    on,
    `select l.state as lease, l.fence::text as fence, l.expires_at::text as expires,
            run.state as run, t.revision::text as revision, t.data ->> 'status' as status,
            (d.revoked_at is not null) as delegation_revoked, att.dispatch_marker
       from public.leases l
       join public.records t on t.business_id = l.business_id and t.id = l.task_id
       join public.reservations res on res.business_id = l.business_id and res.id = l.reservation_id
       join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
       join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
       left join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.business_id = $1 and l.id = $2`,
    [on.business, w.picked['leaseId']],
  );

const expire = async (on: Schedules, w: Work): Promise<void> => {
  await on.db.admin.execute(
    `update public.leases set expires_at = now() - interval '1 minute' where id = $1`,
    [w.picked['leaseId']],
  );
};

describe.skipIf(url === undefined)(
  'T3f an expired lease moves money only',
  { timeout: 60_000 },
  () => {
    let s: Schedules;
    let other: Schedules;
    const h = t2dHarness(() => s);
    const o = t2dHarness(() => other);

    beforeAll(async () => {
      s = await openSchedules('t3f', 1_000_000);
      other = await openSecond(s, 't3f-other');
    }, 180_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it('expired_lease_money_only: the money settles and is marked expired; no work moves, and every work transition is refused', async () => {
      const w = await h.work();
      await h.applied(w);
      await expire(s, w);
      const before = await workState(s, w);

      // Work transitions from the expired lease: each refused, nothing written.
      const renew = await h.held(w, { command: 'task.heartbeat', leaseSeconds: 900 });
      const again = await h.held(w, { command: 'task.dispatch' });
      const back = await h.held(w, handbackBody(w.picked));
      expect([codeOf(renew), codeOf(again), codeOf(back)]).toStrictEqual([
        'LEASE_EXPIRED',
        'LEASE_EXPIRED',
        'LEASE_EXPIRED',
      ]);
      expect(await workState(s, w)).toStrictEqual(before);

      // The money: settled at the book's price, its origin marked.
      const observed = appliedDetail(await h.observeOf(w, { usage: PRICED }), 'task.observe');
      expect(observed).toMatchObject({ lease: 'expired', settlement: { state: 'settled' } });
      expect(await h.money(w)).toMatchObject({ state: 'actual', attempt_state: 'settled' });
      expect(await workState(s, w)).toStrictEqual(before);

      // The mark is stored with the answer: the register replays it.
      const stored = await rows<{ readonly lease: string }>(
        s,
        `select result -> 'detail' ->> 'lease' as lease from public.operations
        where business_id = $1 and command = 'task.observe' and outcome = 'applied'
          and result -> 'detail' ->> 'attemptId' = $2`,
        [s.business, w.attemptId],
      );
      expect(stored).toEqual([{ lease: 'expired' }]);
    });

    it('a live lease settles marked live, so the mark tells the two apart', async () => {
      const w = await h.work();
      await h.applied(w);
      const observed = appliedDetail(await h.observeOf(w, { usage: PRICED }), 'task.observe');
      expect(observed).toMatchObject({ lease: 'live', settlement: { state: 'settled' } });
    });

    it("business to business: an expired lease settles only its own business's money; another business's lease is not its own", async () => {
      const mine = await h.work();
      await h.applied(mine);
      const theirs = await o.work();
      await o.applied(theirs);
      await expire(s, mine);
      const theirMoney = await o.money(theirs);
      const theirWork = await workState(other, theirs);

      // Our worker names their lease, fence and attempt in our business: not ours.
      const crossed = await h.held(
        { ...mine, picked: theirs.picked, attemptId: theirs.attemptId },
        { command: 'task.observe', attemptId: theirs.attemptId, usage: PRICED },
      );
      expect(codeOf(crossed)).toBe('LEASE_NOT_OWNED');
      expect(JSON.stringify(crossed)).not.toContain(theirs.taskId);

      appliedDetail(await h.observeOf(mine, { usage: PRICED }), 'task.observe');
      expect(await o.money(theirs)).toStrictEqual(theirMoney);
      expect(await workState(other, theirs)).toStrictEqual(theirWork);
    });
  },
);
