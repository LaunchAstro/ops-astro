// SPDX-License-Identifier: AGPL-3.0-only
//
// Retention's owed asks (#475), read by both sides of the trace store. An ask
// (`trace_expiry_asks`) is owed until a batch confirms its run at the ask's
// place or later: until then the store may yet apply the delete. Retention
// reads the owed asks back each pass; the export sends a run with one whole.

import type { TenantQuery } from '../../core-records/src/index.ts';

/**
 * The owed asks, one per run at its latest place: `$1` the business, `$2` the
 * runs it is limited to, or null for every run.
 */
export const OWED_ASKS = `select distinct on (a.run_id) a.run_id, a.after_tx, a.after_id
       from public.trace_expiry_asks a
      where a.business_id = $1 and ($2::uuid[] is null or a.run_id = any($2::uuid[]))
        and not exists (select 1 from public.trace_expiry_batches b
                         where b.business_id = $1 and b.expired_run_ids @> array[a.run_id]
                           and (b.after_tx, b.after_id) >= (a.after_tx, a.after_id))
      order by a.run_id, a.after_tx desc, a.after_id desc`;

/**
 * The most events one export sends again, so a long run cannot grow a body
 * past what the target takes; beyond it the earliest go, and the read back
 * finds a later delete as before.
 */
const OWED_RESEND = 100;

/**
 * A run with an owed ask goes whole: with any event of it in an export's
 * `batch`, its events since the ask's place that are behind `from` and inside
 * the window go again (`cells` are the export's span columns over `ev`). A
 * delete that lands between two exports leaves a trace of the later events
 * only, which reads back present; sent whole, it holds every one.
 */
export async function owedSince<T>(
  tx: TenantQuery,
  cells: string,
  batch: readonly { readonly runId: string; readonly past: boolean }[],
  from: { readonly tx: string | null; readonly id: string | null },
  windowDays: number,
): Promise<readonly T[]> {
  const runs = [...new Set(batch.filter((row) => !row.past).map((row) => row.runId))];
  if (runs.length === 0 || from.tx === null) return [];
  return await tx.query<T>(
    `with owed as (${OWED_ASKS})
     select ${cells}
       from public.run_events ev
       join owed o on o.run_id = ev.run_id
      where ev.business_id = $1
        and (ev.tx, ev.id) > (o.after_tx, o.after_id)
        and (ev.tx, ev.id) <= ($3::xid8, $4::uuid)
        and ev.created_at >= now() - make_interval(days => $5)
      order by ev.tx, ev.id
      limit $6`,
    [tx.businessId, runs, from.tx, from.id, windowDays, OWED_RESEND],
  );
}
