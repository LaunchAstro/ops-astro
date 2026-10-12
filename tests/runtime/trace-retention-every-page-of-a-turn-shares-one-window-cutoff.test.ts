// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: a business's owed runs are read page after page in turn
// order, and a run's turn is its latest reading row inside the window. Every
// page of one turn judges the window from the same instant. Owed run A sorts
// before B by id, and A's last reading row sits six seconds inside the
// window edge, so A's turn comes after B's. The pass reads a page of one run
// at a time, four seconds apart. Were each page to judge the window from its
// own clock, A's row would leave the window between the pages, A's turn would
// drop before B's, and the page after B would pass A by unread.

import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { TraceDatabase } from '../../packages/core-runtime/src/index.ts';
import { expireOnce, TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { rows } from './schedules-harness.ts';
import { noDatabase, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';
import { owedRuns, traceOf, watched } from './trace-retention-pass-world.ts';

useAw13World('trret_one_window_cutoff');

/** `db`, with every transaction after its first started four seconds late. */
function slowed(db: TraceDatabase): TraceDatabase {
  let calls = 0;
  return {
    withBusiness: async (businessId, run) => {
      calls += 1;
      if (calls > 1) await sleep(4_000);
      return await db.withBusiness(businessId, run);
    },
  };
}

it.skipIf(noDatabase)(
  'Trace retention: every page of a turn shares one window cutoff',
  async () => {
    const s = t.alpha;
    const [a = '', b = ''] = await owedRuns(s, 'trace retention one cutoff', 2);
    await rows(
      s,
      `insert into public.trace_expiry_batches
         (business_id, id, window_days, runs, expired_run_ids, code, read_run_ids, recorded_at)
       values ($1, gen_random_uuid(), $2, 1, '{}', 'expiry_unconfirmed', array[$3::uuid],
               clock_timestamp() - make_interval(days => $2) + interval '6 seconds')`,
      [s.business, TRACE_WINDOW_DAYS, a],
    );

    const { ports, seen } = watched();
    await expireOnce(slowed(s.db.app), s.business, TRACE_KEY, ports, { page: 1 });
    expect(
      seen.map((read) => read.trace),
      'both owed runs are read, B first',
    ).toEqual([traceOf(s, b), traceOf(s, a)]);
  },
  60_000,
);
