// SPDX-License-Identifier: AGPL-3.0-only
//
// A budget-stop end that waits on the run's row lock must not stamp an end
// earlier than the instant the run could actually leave work. The purge window
// runs from `planned_runs.ended_at` (conversation-work.ts `runWork`,
// conversation-lifecycle.ts `purgeHold`).

import { expect, it } from 'vitest';
import { endAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { awaitParked, barrier, racer } from '../runtime/schedules-harness.ts';
import { s, useBrokerWorld } from '../broker/broker-world.ts';
import { as, one, people, stopped, usePeople } from '../broker/budget-answers-world.ts';

useBrokerWorld('auditb3fix21');
usePeople();

const WINDOW_DAYS = 7;

it('a lock-delayed budget-stop end is not stamped before the lock released', async () => {
  const { runId, askId } = await stopped('audit b3fix2.1 delayed end');
  const holderDb = racer(s);
  const enderDb = racer(s);
  const locked = barrier();
  const gate = barrier();
  let releaseAt!: Date;
  try {
    // Connection A: lock the run row without changing it.
    const holding = holderDb.withBusiness(s.business, async (tx) => {
      await tx.query(
        `select 1 from public.planned_runs where business_id = $1 and id = $2 for update`,
        [tx.businessId, runId],
      );
      locked.release();
      await gate.held;
      const [row] = await tx.query<{ at: Date }>(`select clock_timestamp() as at`);
      if (row === undefined) throw new Error('no clock');
      releaseAt = row.at;
    });
    await locked.held;

    // Connection B: the person's end, which must wait on A's run lock.
    const ending = enderDb.withBusiness(
      s.business,
      async (tx) => await endAtBudgetStop(tx, { ...as(people.second, runId), askId }),
    );
    await awaitParked(s, 'planned_runs', 1);
    // The measurable delay is the lock wait itself.
    await new Promise((resolve) => {
      setTimeout(resolve, 1000);
    });
    gate.release();
    await holding;
    const ended = await ending;
    expect(ended.ok ? 'applied' : ended.refusal.code).toBe('applied');
  } finally {
    await holderDb.close();
    await enderDb.close();
  }

  const stamped = await one<{
    state: string;
    ended_at: Date;
    at_or_after_release: boolean;
    gap_ms: string;
    purge_due_before_actual_window: boolean;
  }>(
    // At the instant stamped end + window (purgeHold's predicate, with last
    // activity older), the body is already due, though the actual end plus
    // the window has not yet passed.
    `select r.state, r.ended_at,
            r.ended_at >= $2::timestamptz as at_or_after_release,
            (extract(epoch from ($2::timestamptz - r.ended_at)) * 1000)::bigint::text as gap_ms,
            (r.ended_at <= (r.ended_at + make_interval(days => $3::int)) - make_interval(days => $3::int)
             and r.ended_at + make_interval(days => $3::int)
                 < $2::timestamptz + make_interval(days => $3::int)) as purge_due_before_actual_window
       from public.planned_runs r where r.id = $1`,
    [runId, releaseAt, WINDOW_DAYS],
  );
  expect(
    {
      state: stamped.state,
      at_or_after_release: stamped.at_or_after_release,
      purge_due_before_actual_window: stamped.purge_due_before_actual_window,
    },
    `ended_at ${stamped.ended_at.toISOString()} vs releaseAt ${releaseAt.toISOString()} (gap ${stamped.gap_ms} ms)`,
  ).toEqual({
    state: 'cancelled',
    at_or_after_release: true,
    purge_due_before_actual_window: false,
  });
});
