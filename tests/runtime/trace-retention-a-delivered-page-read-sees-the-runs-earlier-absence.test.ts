// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: a run read gone once is not confirmed, and the read is
// recorded. When the run takes a later event that goes out and then passes
// the window too, the next pass asks it again at a later place, deletes it
// and reads it back with its delivered page. That read looks the run's
// history up as an owed read does, sees the absence the pass before read,
// and confirms the run at its new place.

import { expect, it } from 'vitest';
import { TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { rows } from './schedules-harness.ts';
import { age, append } from './aw-13-retention-world.ts';
import { awaitDue, drain, noDatabase, t, useAw13World } from './aw-13-world.ts';
import { confirmed, dueRuns, pass, traceOf, watched } from './trace-retention-pass-world.ts';

useAw13World('trret_delivered_history');

it.skipIf(noDatabase)(
  'Trace retention: a delivered page read sees the run’s earlier absence',
  async () => {
    const s = t.alpha;
    const [runId = ''] = await dueRuns(s, 'trace retention delivered history', 1);
    await pass(s, t.target.expiry);
    expect(await confirmed(s, runId), 'one read gone confirms nothing').toBe(false);

    await append(runId, 1);
    await awaitDue(s);
    await drain(s);
    await age(runId, TRACE_WINDOW_DAYS + 1);
    const { ports, seen } = watched();
    await pass(s, ports);
    expect(
      seen.map((one) => one.op),
      'asked again, deleted and read back',
    ).toEqual(['DELETE', 'GET']);
    expect(seen[1]).toMatchObject({ trace: traceOf(s, runId), answer: 'absent' });
    const places = await rows<{ confirms: boolean }>(
      s,
      `select b.expired_run_ids @> array[$2::uuid] as confirms
         from public.trace_expiry_batches b
        where b.business_id = $1 and b.after_tx is not null
          and (b.after_tx, b.after_id) = (
                select a.after_tx, a.after_id from public.trace_expiry_asks a
                 where a.business_id = $1 and a.run_id = $2
                 order by a.after_tx desc, a.after_id desc limit 1)`,
      [s.business, runId],
    );
    expect(
      places.some((one) => one.confirms),
      'the delivered page confirms the run at its new place',
    ).toBe(true);
  },
);
