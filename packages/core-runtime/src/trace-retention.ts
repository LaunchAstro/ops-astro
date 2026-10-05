// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: trace retention. The product is the trace store's deletion authority
// (contract 7.3): no vendor mechanism deletes a trace on this profile, so a
// pass here does, per business, from the product's own records.
//
// 1. The due runs: a registered trace copy, every event behind the export's
//    cursor (a pending event would be exported after its trace was deleted),
//    the newest event older than the window, and no batch confirming it
//    since that event. At most one page of the endpoint's cap.
// 2. Their trace ids, derived as the exporter derives them; no listing.
// 3. One delete for the page, through the port (custody's egress). An event
//    of a page's run can be written and exported between the selection and
//    the delete, and the delete takes it too. So after the delete, answered
//    or not, when a page's run has an event past the selection's cursor, the
//    export's cursor goes back to where the selection read it (if it moved
//    past) and takes a new version, which an export read before then cannot
//    advance from. The export sends those events again (their ids are
//    derived, so a re-send is the same span), starting the trace afresh.
// 4. Each id read back: the endpoint may answer success for work its guard
//    skipped, so only a read that finds nothing confirms a run.
// 5. One batch row, append only (0103): the window, the runs asked, the runs
//    confirmed, and the gap code when the batch did not finish. A failed
//    delete confirms nothing; an unconfirmed run is simply due again.
//
// The raw event copy is not this pass's: the bucket's lifecycle rule is its
// whole deletion path (the pinned profile's `minio` command).

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { gapOf, type Delivered, type GapCode, type TraceDatabase } from './trace-export.ts';
import { derivedId } from './trace-span.ts';

/** The trace window, in days (contract 7.5). */
export const TRACE_WINDOW_DAYS = 30;
/** The deletion endpoint's cap on ids per call. */
export const EXPIRY_PAGE = 1_000;

/** The trace store as retention asks it: delete ids, then read one back. */
export interface ExpiryPorts {
  expire(traceIds: readonly string[]): Promise<Delivered>;
  present(traceId: string): Promise<'absent' | 'present' | 'unknown'>;
}

export type ExpiryCode = GapCode | 'expiry_unconfirmed';

export interface RetentionBatch {
  readonly runs: number;
  readonly confirmed: number;
  readonly code: ExpiryCode | null;
}

/** One pass for one business: page after page until nothing is due or a batch does not finish. */
export async function expireOnce(
  database: TraceDatabase,
  businessId: string,
  key: Buffer,
  ports: ExpiryPorts,
  options: { readonly windowDays?: number; readonly page?: number } = {},
): Promise<readonly RetentionBatch[]> {
  const windowDays = options.windowDays ?? TRACE_WINDOW_DAYS;
  const page = options.page ?? EXPIRY_PAGE;
  const batches: RetentionBatch[] = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- one page after another
    const selected = await database.withBusiness(
      businessId,
      async (tx) => await due(tx, windowDays, page),
    );
    const { runs } = selected;
    if (runs.length === 0) break;
    const ids = runs.map((runId) => derivedId(key, ['trace', businessId, runId], 32));
    // eslint-disable-next-line no-await-in-loop -- one page after another
    const answer = await ports.expire(ids);
    // eslint-disable-next-line no-await-in-loop -- one page after another
    await database.withBusiness(businessId, async (tx) => await resend(tx, selected));
    // eslint-disable-next-line no-await-in-loop -- one page after another
    const batch = await confirmBatch(
      database,
      businessId,
      ports,
      { runs, ids, answer },
      windowDays,
    );
    batches.push(batch);
    // A finished batch confirmed every run it asked, so the next page is new runs.
    if (batch.code !== null || runs.length < page) break;
  }
  return batches;
}

/** The due runs, and the export's cursor as the selection read it. */
interface Selected {
  readonly runs: readonly string[];
  readonly afterTx: string | null;
  readonly afterId: string | null;
}

async function due(tx: TenantQuery, windowDays: number, page: number): Promise<Selected> {
  const rows = await tx.query<{
    readonly run_id: string;
    readonly after_tx: string | null;
    readonly after_id: string | null;
  }>(
    `with last as (
       select run_id, max(created_at) as last_at from public.run_events
        where business_id = $1 group by run_id
     ), confirmed as (
       select run_id, max(b.recorded_at) as at
         from public.trace_expiry_batches b, unnest(b.expired_run_ids) as run_id
        where b.business_id = $1 group by run_id
     )
     select l.run_id, cur.after_tx::text as after_tx, cur.after_id from last l
       join public.copy_registrations c
         on c.business_id = $1 and c.copy_class = 'diagnostic_trace'
        and c.copy_key = 'run:' || l.run_id::text
       join public.trace_export_cursors cur on cur.business_id = $1
       left join confirmed e on e.run_id = l.run_id
      where l.last_at < now() - make_interval(days => $2)
        and (e.at is null or e.at < l.last_at)
        and not exists (select 1 from public.run_events p
                         where p.business_id = $1 and p.run_id = l.run_id
                           and (p.tx, p.id) > (cur.after_tx, cur.after_id))
      order by l.run_id
      limit $3`,
    [tx.businessId, windowDays, page],
  );
  return {
    runs: rows.map((row) => row.run_id),
    afterTx: rows[0]?.after_tx ?? null,
    afterId: rows[0]?.after_id ?? null,
  };
}

/**
 * When a run just deleted has an event past the selection's cursor (exported,
 * in flight or still to go): the cursor back to the selection's if it moved
 * past it, and a new version either way, so the export sends those events
 * again. No such event, the cursor is left alone.
 */
async function resend(tx: TenantQuery, { runs, afterTx, afterId }: Selected): Promise<void> {
  await tx.query(
    `update public.trace_export_cursors c
        set (after_tx, after_id) = (
              select case when moved then $2::text::xid8 else c.after_tx end,
                     case when moved then $3::uuid else c.after_id end
                from (select c.after_tx is not null
                         and ($2::text is null
                              or (c.after_tx, c.after_id) > ($2::text::xid8, $3::uuid)) as moved) m),
            updated_at = clock_timestamp()
      where c.business_id = $1
        and exists (select 1 from public.run_events ev
                     where ev.business_id = $1 and ev.run_id = any($4::uuid[])
                       and ($2::text is null or (ev.tx, ev.id) > ($2::text::xid8, $3::uuid)))`,
    [tx.businessId, afterTx, afterId, runs],
  );
}

async function confirmBatch(
  database: TraceDatabase,
  businessId: string,
  ports: ExpiryPorts,
  {
    runs,
    ids,
    answer,
  }: {
    readonly runs: readonly string[];
    readonly ids: readonly string[];
    readonly answer: Delivered;
  },
  windowDays: number,
): Promise<RetentionBatch> {
  let code: ExpiryCode | null = gapOf(answer);
  const confirmed: string[] = [];
  if (code === null) {
    for (const [at, runId] of runs.entries()) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time; the store is not hurried
      if ((await ports.present(ids[at] ?? '')) === 'absent') confirmed.push(runId);
    }
    if (confirmed.length < runs.length) code = 'expiry_unconfirmed';
  }
  await database.withBusiness(businessId, async (tx) => {
    await tx.query(
      `insert into public.trace_expiry_batches
         (business_id, id, window_days, runs, expired_run_ids, code)
       values ($1, $2, $3, $4, $5::uuid[], $6)`,
      [tx.businessId, randomUUID(), windowDays, runs.length, confirmed, code],
    );
  });
  return { runs: runs.length, confirmed: confirmed.length, code };
}
