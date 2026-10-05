// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: trace retention. The product is the trace store's deletion authority
// (contract 7.3): no vendor mechanism deletes a trace on this profile, so a
// pass here does, per business, from the product's own records.
//
// 1. The due runs: a registered trace copy, every event behind the export's
//    cursor (a pending event would be exported after its trace was deleted),
//    the newest event older than the window, and an event after the place of
//    the run's last confirmation, if it has one. At most one page of the
//    endpoint's cap. The same transaction writes an ask per run (#475), with
//    the cursor it read: the run's place.
// 2. Their trace ids, derived as the exporter derives them; no listing.
// 3. One delete for the page, through the port (custody's egress).
// 4. Each id read back: the endpoint may answer success for work its guard
//    skipped, so only a read that finds nothing confirms a run.
// 5. One batch row, append only (0103): the window, the runs asked, the runs
//    confirmed at their place, and the gap code when the batch did not
//    finish. A failed delete confirms nothing.
//
// The store applies a delete whenever it likes: after a timeout, after this
// pass failed, after a fresh event of the run went out into the trace it
// takes, and a confirmation proves one delete landed, never that another is
// not queued. So an ask stays owed until a batch confirms its run at its
// place or later, and while the run has an event after that place inside the
// window (`trace-owed.ts`); every pass reads back every owed ask it did not
// just make, page after page; how a run is read, and what ends the reading,
// is `trace-store.ts`.
// A run found gone has its events after its place sent again (`sendAgain`)
// in the transaction that confirms it, or, when it has such events, holds
// it back with its ask still owed. The export sends a run with an owed ask
// whole whenever it sends one of its events (`trace-export.ts`). A
// confirmation covers only the events up to its place, so a run with a later
// event, even one committed after the pass, is due again once that event is
// past the window.
//
// The raw event copy is not this pass's: the bucket's lifecycle rule is its
// whole deletion path (the pinned profile's `minio` command).

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { gapOf, type GapCode } from './trace-delivery.ts';
import { TRACE_WINDOW_DAYS, type Cursor, type TraceDatabase } from './trace-export.ts';
import { byPlace, owedAsks, stepBack, type Owed, type OwedFrom } from './trace-owed.ts';
import {
  readBack,
  traceOf,
  unanswered,
  UNANSWERED,
  type ExpiryPorts,
  type Reading,
} from './trace-store.ts';

/** The deletion endpoint's cap on ids per call. */
export const EXPIRY_PAGE = 1_000;

export type ExpiryCode = GapCode | 'expiry_unconfirmed';

export interface RetentionBatch {
  readonly runs: number;
  readonly confirmed: number;
  readonly code: ExpiryCode | null;
}

/** One pass for one business: page after page until nothing is due or a batch does not finish, then the asks still owed. */
export async function expireOnce(
  database: TraceDatabase,
  businessId: string,
  key: Buffer,
  ports: ExpiryPorts,
  options: { readonly windowDays?: number; readonly page?: number } = {},
): Promise<readonly RetentionBatch[]> {
  const windowDays = options.windowDays ?? TRACE_WINDOW_DAYS;
  const page = Math.max(1, options.page ?? EXPIRY_PAGE);
  const batches: RetentionBatch[] = [];
  const asked = new Set<string>();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- one page after another
    const ask = await database.withBusiness(
      businessId,
      async (tx) => await askDue(tx, windowDays, page),
    );
    if (ask.runs.length === 0) break;
    for (const runId of ask.runs) asked.add(runId);
    // eslint-disable-next-line no-await-in-loop -- one page after another
    const batch = await expirePage(database, businessId, key, ports, ask, windowDays);
    batches.push(batch);
    // A finished batch confirmed every run it asked, so the next page is new runs.
    if (batch.code !== null || ask.runs.length < page) break;
  }
  batches.push(...(await readOwed(database, businessId, key, ports, asked, windowDays, page)));
  return batches;
}

/**
 * Every owed run not just asked, page after page in turn order, whatever its
 * place: a page that stays present does not hide the next. The runs found
 * gone are confirmed by place; the runs the store did not answer are recorded.
 */
async function readOwed(
  database: TraceDatabase,
  businessId: string,
  key: Buffer,
  ports: ExpiryPorts,
  asked: ReadonlySet<string>,
  windowDays: number,
  page: number,
): Promise<readonly RetentionBatch[]> {
  const batches: RetentionBatch[] = [];
  const reading: Reading = { firsts: new Map(), unanswered: [], quiet: 0 };
  let after: OwedFrom | null = null;
  while (reading.quiet < UNANSWERED) {
    const from: OwedFrom | null = after;
    // eslint-disable-next-line no-await-in-loop -- one page after another
    const owed: readonly Owed[] = await database.withBusiness(
      businessId,
      async (tx) => await owedAsks(tx, windowDays, from, page),
    );
    for (const row of owed) if (row.first !== null) reading.firsts.set(row.runId, row.first);
    const due = owed.filter((row) => !asked.has(row.runId));
    const runs = due.map((row) => row.runId);
    // eslint-disable-next-line no-await-in-loop -- one page after another; the store is not hurried
    const gone = new Set(await readBack(key, businessId, ports, runs, reading));
    for (const ask of byPlace(due.filter((row) => gone.has(row.runId)))) {
      // eslint-disable-next-line no-await-in-loop -- one place after another
      batches.push(await confirm(database, businessId, ask, ask.runs, null, windowDays));
    }
    const end = owed.at(-1);
    if (owed.length < page || end === undefined) break;
    after = { turn: end.turn, runId: end.runId };
  }
  if (reading.unanswered.length > 0) {
    await database.withBusiness(
      businessId,
      async (tx) => await unanswered(tx, reading, windowDays),
    );
  }
  return batches;
}

/** The export's cursor as an ask read it: every event of its runs up to it was behind it. */
type Place = Pick<Cursor, 'tx' | 'id'>;

interface Ask {
  readonly runs: readonly string[];
  readonly place: Place;
}

/** The due runs, and an ask for each written before anything is deleted. */
async function askDue(tx: TenantQuery, windowDays: number, page: number): Promise<Ask> {
  const rows = await tx.query<{ readonly run_id: string } & Place>(
    `with last as (
       select run_id, max(created_at) as last_at from public.run_events
        where business_id = $1 group by run_id
     ), confirmed as (
       select distinct on (run_id) run_id, b.after_tx, b.after_id
         from public.trace_expiry_batches b, unnest(b.expired_run_ids) as run_id
        where b.business_id = $1 and b.after_tx is not null
        order by run_id, b.after_tx desc, b.after_id desc
     )
     select l.run_id, cur.after_tx::text as tx, cur.after_id as id from last l
       join public.copy_registrations c
         on c.business_id = $1 and c.copy_class = 'diagnostic_trace'
        and c.copy_key = 'run:' || l.run_id::text
       join public.trace_export_cursors cur on cur.business_id = $1
       left join confirmed e on e.run_id = l.run_id
      where l.last_at < now() - make_interval(days => $2)
        and (e.run_id is null
             or exists (select 1 from public.run_events p
                         where p.business_id = $1 and p.run_id = l.run_id
                           and (p.tx, p.id) > (e.after_tx, e.after_id)))
        and not exists (select 1 from public.run_events p
                         where p.business_id = $1 and p.run_id = l.run_id
                           and (p.tx, p.id) > (cur.after_tx, cur.after_id))
      order by l.run_id
      limit $3`,
    [tx.businessId, windowDays, page],
  );
  const runs = rows.map((row) => row.run_id);
  const place = { tx: rows[0]?.tx ?? null, id: rows[0]?.id ?? null };
  if (runs.length > 0) {
    await tx.query(
      `insert into public.trace_expiry_asks (business_id, id, run_id, after_tx, after_id)
       select $1, gen_random_uuid(), run_id, $3::xid8, $4::uuid from unnest($2::uuid[]) as run_id`,
      [tx.businessId, runs, place.tx, place.id],
    );
  }
  return { runs, place };
}

/** One page: the delete, each id read back when it landed, and the batch. */
async function expirePage(
  database: TraceDatabase,
  businessId: string,
  key: Buffer,
  ports: ExpiryPorts,
  ask: Ask,
  windowDays: number,
): Promise<RetentionBatch> {
  const code = gapOf(await ports.expire(ask.runs.map((runId) => traceOf(key, businessId, runId))));
  const gone = code === null ? await readBack(key, businessId, ports, ask.runs) : [];
  return await confirm(database, businessId, ask, gone, code, windowDays);
}

/** One transaction: the gone runs' later events sent again, and the batch confirming them at the ask's place. */
async function confirm(
  database: TraceDatabase,
  businessId: string,
  ask: Ask,
  gone: readonly string[],
  code: ExpiryCode | null,
  windowDays: number,
): Promise<RetentionBatch> {
  return await database.withBusiness(businessId, async (tx) => {
    const held = gone.length > 0 ? await sendAgain(tx, gone, ask.place) : new Set<string>();
    const kept = gone.filter((runId) => !held.has(runId));
    const settled = code ?? (kept.length < ask.runs.length ? 'expiry_unconfirmed' : null);
    await tx.query(
      `insert into public.trace_expiry_batches
         (business_id, id, window_days, runs, expired_run_ids, code, after_tx, after_id)
       values ($1, $2, $3, $4, $5::uuid[], $6, $7::xid8, $8::uuid)`,
      [
        tx.businessId,
        randomUUID(),
        windowDays,
        ask.runs.length,
        kept,
        settled,
        ask.place.tx,
        ask.place.id,
      ],
    );
    return { runs: ask.runs.length, confirmed: kept.length, code: settled };
  });
}

/**
 * A gone run's events after its place were in the trace the delete took, or
 * will be sent after it: the cursor steps back before the earliest
 * (`stepBack`). Answers the runs it found, which the batch does not confirm:
 * their asks stay owed, and each is due again once its later event is past
 * the window.
 */
async function sendAgain(
  tx: TenantQuery,
  runs: readonly string[],
  place: Place,
): Promise<ReadonlySet<string>> {
  const rows = await tx.query<{ readonly runId: string }>(
    `${stepBack(`select ev.run_id, ev.tx, ev.id from public.run_events ev
        where ev.business_id = $1 and ev.run_id = any($2::uuid[])
          and (ev.tx, ev.id) > ($3::xid8, $4::uuid)`)}
     select distinct run_id as "runId" from fresh`,
    [tx.businessId, runs, place.tx, place.id],
  );
  return new Set(rows.map((row) => row.runId));
}
