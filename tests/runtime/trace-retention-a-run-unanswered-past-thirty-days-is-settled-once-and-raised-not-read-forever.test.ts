// SPDX-License-Identifier: AGPL-3.0-only
//
// Trace retention: a run whose trace never answers a read is owed, and each
// pass that reads it records a row. That cannot go on for ever. Once the
// run's ask is older than the window and still unconfirmed, the next pass
// settles it once: one row with the code `unconfirmed_expired` naming the
// business and the run, which the pass answers as well, and the run is
// never read or asked again.

import { expect, it } from 'vitest';
import { TRACE_WINDOW_DAYS } from '../../packages/core-runtime/src/index.ts';
import { rows } from './schedules-harness.ts';
import { noDatabase, t, useAw13World } from './aw-13-world.ts';
import { dueRuns, pass, traceOf, watched } from './trace-retention-pass-world.ts';

useAw13World('trret_settled_unanswered');

it.skipIf(noDatabase)(
  'Trace retention: a run unanswered past thirty days is settled once and raised, not read forever',
  async () => {
    const s = t.alpha;
    const [runId = ''] = await dueRuns(s, 'trace retention settled unanswered', 1);
    const trace = traceOf(s, runId);
    const silent = (asked: string): 'unknown' | undefined =>
      asked === trace ? 'unknown' : undefined;
    await pass(s, watched(silent).ports);
    await pass(s, watched(silent).ports);
    await t.alpha.db.admin.execute(
      `do $$ begin
         set local session_replication_role = replica;
         update public.trace_expiry_asks
            set asked_at = asked_at - make_interval(days => ${String(TRACE_WINDOW_DAYS + 1)})
          where run_id = '${runId}';
       end $$`,
    );

    const settling = watched(silent);
    const settled = await pass(s, settling.ports);
    expect(settled, 'the pass raises the settled run').toContainEqual({
      runs: 1,
      confirmed: 0,
      code: 'unconfirmed_expired',
    });
    expect(
      settling.seen.map((one) => one.trace),
      'the settled run is not read',
    ).not.toContain(trace);

    const later = watched(silent);
    await pass(s, later.ports);
    expect(
      later.seen.map((one) => one.trace),
      'nor read or asked again',
    ).not.toContain(trace);
    const rowsOf = await rows<{ business_id: string; unread_run_ids: string[] }>(
      s,
      `select business_id, unread_run_ids::text[] as unread_run_ids
         from public.trace_expiry_batches where business_id = $1 and code = 'unconfirmed_expired'`,
      [s.business],
    );
    expect(rowsOf, 'one row names the business and the run').toEqual([
      { business_id: s.business, unread_run_ids: [runId] },
    ]);
  },
);
