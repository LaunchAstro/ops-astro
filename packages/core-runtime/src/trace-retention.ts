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
// 5. One batch row, append only (0103): the window, the runs asked, the runs
//    confirmed, and the gap code when the batch did not finish. A failed
//    delete confirms nothing; an unconfirmed run is simply due again.
//
// A run can take a new event after step 1, and an export can send it before
// step 3 deletes the trace it landed in. So step 5's transaction rechecks
// first (`stepBack`): when a run asked has an event after the cursor step 1
// read, the cursor steps back to just before the earliest such event under
// its row lock, the lock the export's advance takes, and its version
// changes. Those events go again, an export that read before the step never
// advances, and the batch does not confirm those runs: each is due again once
// its fresh event is past the window.
//
// The raw event copy is not this pass's: the bucket's lifecycle rule is its
// whole deletion path (the pinned profile's `minio` command).

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import {
  gapOf,
  TRACE_WINDOW_DAYS,
  type Cursor,
  type Delivered,
  type GapCode,
  type TraceDatabase,
} from './trace-export.ts';
import { derivedId } from './trace-span.ts';

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
    const { runs, cursor } = await database.withBusiness(
      businessId,
      async (tx) => await due(tx, windowDays, page),
    );
    if (runs.length === 0) break;
    // eslint-disable-next-line no-await-in-loop -- one page after another
    const batch = await expireBatch(database, businessId, key, ports, runs, cursor, windowDays);
    batches.push(batch);
    // A finished batch confirmed every run it asked, so the next page is new runs.
    if (batch.code !== null || runs.length < page) break;
  }
  return batches;
}

/** The export's cursor as the due check read it. */
type Place = Pick<Cursor, 'tx' | 'id'>;

async function due(
  tx: TenantQuery,
  windowDays: number,
  page: number,
): Promise<{ readonly runs: readonly string[]; readonly cursor: Place }> {
  const rows = await tx.query<{ readonly run_id: string } & Place>(
    `with last as (
       select run_id, max(created_at) as last_at from public.run_events
        where business_id = $1 group by run_id
     ), confirmed as (
       select run_id, max(b.recorded_at) as at
         from public.trace_expiry_batches b, unnest(b.expired_run_ids) as run_id
        where b.business_id = $1 group by run_id
     )
     select l.run_id, cur.after_tx::text as tx, cur.after_id as id from last l
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
    cursor: { tx: rows[0]?.tx ?? null, id: rows[0]?.id ?? null },
  };
}

async function expireBatch(
  database: TraceDatabase,
  businessId: string,
  key: Buffer,
  ports: ExpiryPorts,
  runs: readonly string[],
  cursor: Place,
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
  // A run held back by the step back is not confirmed: its trace takes the
  // fresh event again, and the run is due again once that event is past the
  // window. A batch that confirms fewer runs than it asked carries a code
  // (0103), so it is `expiry_unconfirmed`, as for a delete the store skipped.
  return await database.withBusiness(businessId, async (tx) => {
    const held = await stepBack(tx, runs, cursor);
    const kept = confirmed.filter((runId) => !held.has(runId));
    const settled = code ?? (kept.length < runs.length ? 'expiry_unconfirmed' : null);
    await tx.query(
      `insert into public.trace_expiry_batches
         (business_id, id, window_days, runs, expired_run_ids, code)
       values ($1, $2, $3, $4, $5::uuid[], $6)`,
      [tx.businessId, randomUUID(), windowDays, runs.length, kept, settled],
    );
    return { runs: runs.length, confirmed: kept.length, code: settled };
  });
}

/**
 * The recheck after a delete: a run asked with an event after `from`, the
 * cursor the due check read, may have had that event exported into the trace
 * the delete took. The cursor goes back to just before the earliest such
 * event, or stays if it is already behind that, and the update gives the row
 * a new version even when the place is the same, under the row lock the
 * export's `advance` takes. Only events from there on go again, so a run
 * another pass has just confirmed is not sent back: its events were written
 * before that run fell past the window, and sort before any fresh event
 * unless a transaction stayed open longer than the window. An event that commits after this statement's snapshot is
 * read after it too, so it is sent after the delete and needs nothing.
 * Answers the runs it found, which this batch does not confirm.
 */
async function stepBack(
  tx: TenantQuery,
  runs: readonly string[],
  from: Pick<Cursor, 'tx' | 'id'>,
): Promise<ReadonlySet<string>> {
  const rows = await tx.query<{ readonly runId: string }>(
    `with fresh as (
       select ev.run_id, ev.tx, ev.id from public.run_events ev
        where ev.business_id = $1 and ev.run_id = any($2::uuid[])
          and ($3::xid8 is null or (ev.tx, ev.id) > ($3::xid8, $4::uuid))
     ), back as (
       select p.tx, p.id from public.run_events p
        where p.business_id = $1
          and (p.tx, p.id) < (select f.tx, f.id from fresh f order by f.tx, f.id limit 1)
        order by p.tx desc, p.id desc limit 1
     ), stepped as (
       update public.trace_export_cursors c
          set (after_tx, after_id) = (
                select b.tx, b.id
                  from (values (c.after_tx, c.after_id),
                               ((select tx from back), (select id from back))) b(tx, id)
                 order by b.tx nulls first, b.id nulls first limit 1),
              updated_at = now()
        where c.business_id = $1 and exists (select 1 from fresh)
     )
     select distinct run_id as "runId" from fresh`,
    [tx.businessId, runs, from.tx, from.id],
  );
  return new Set(rows.map((row) => row.runId));
}
