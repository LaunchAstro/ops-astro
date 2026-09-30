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
// 3. One delete for the page, through the port (custody's egress).
// 4. Each id read back: the endpoint may answer success for work its guard
//    skipped, so only a read that finds nothing confirms a run.
// 5. One batch row, append only (0208): the window, the runs asked, the runs
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
    const runs = await database.withBusiness(
      businessId,
      async (tx) => await due(tx, windowDays, page),
    );
    if (runs.length === 0) break;
    // eslint-disable-next-line no-await-in-loop -- one page after another
    const batch = await expireBatch(database, businessId, key, ports, runs, windowDays);
    batches.push(batch);
    // A finished batch confirmed every run it asked, so the next page is new runs.
    if (batch.code !== null || runs.length < page) break;
  }
  return batches;
}

async function due(tx: TenantQuery, windowDays: number, page: number): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly run_id: string }>(
    `with last as (
       select run_id, max(created_at) as last_at from public.run_events
        where business_id = $1 group by run_id
     ), confirmed as (
       select run_id, max(b.recorded_at) as at
         from public.trace_expiry_batches b, unnest(b.expired_run_ids) as run_id
        where b.business_id = $1 group by run_id
     )
     select l.run_id from last l
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
  return rows.map((row) => row.run_id);
}

async function expireBatch(
  database: TraceDatabase,
  businessId: string,
  key: Buffer,
  ports: ExpiryPorts,
  runs: readonly string[],
  windowDays: number,
): Promise<RetentionBatch> {
  const ids = runs.map((runId) => derivedId(key, ['trace', businessId, runId], 32));
  let code: ExpiryCode | null = gapOf(await ports.expire(ids));
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
