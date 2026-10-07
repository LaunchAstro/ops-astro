// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: the diagnostic trace export. A run's durable events leave as
// timings, counts and codes, never a sentence, to a trace target an operator
// reads. The exporter is outside the execution path: it reads `run_events` by
// its own cursor (0089), on its own transactions, and nothing a run does
// waits on it or reads what it wrote. With the exporter stopped, killed or
// failing, every run settles as before; the durable record is the buffer.
//
// What a span may hold, and how its ids are derived: `trace-span.ts`.
//
// **Delivery is a port** (`Deliver`): the composition root hands the exporter
// custody's egress, which names the target's origin itself, refuses redirects
// and bounds the reply by time and bytes. Anything short of a 2xx JSON reply
// to every body is recorded as a gap with a fixed code and the cursor stays
// where it was; an export with no reachable target is never reported as success.
//
// One export per business at a time, by a lease on its cursor row
// (`trace-lease.ts`): another export meanwhile is `held` and sends nothing.
// A gap whose body may still be stored keeps the lease to its end.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { gapOf, type Deliver, type GapCode } from './trace-delivery.ts';
import { letGo, release, renew, take, type Cursor } from './trace-lease.ts';
import { owedSince } from './trace-owed.ts';
import { derivedId, otlp, traceSpan, type TraceSpan } from './trace-span.ts';
import { cellsOf, EVENT_CELLS, type Row } from './trace-read.ts';

export type { Cursor } from './trace-lease.ts';
export { readTaskTrace, TRACE_READ_LIMIT, type ReadSpan } from './trace-read.ts';

export type ExportOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'held' }
  | { readonly kind: 'delivered'; readonly spans: number }
  | { readonly kind: 'gap'; readonly code: GapCode; readonly spans: number };

/** The most events one export reads, and the most owed events one body sends again. */
export const TRACE_BATCH = 100;

/** The trace window, in days (contract 7.5): an event older than it when read is never sent. */
export const TRACE_WINDOW_DAYS = 30;

type Pending = Row & { readonly past: boolean };

/** The database side the exporter needs: one business's tenant transactions. */
export interface TraceDatabase {
  withBusiness<T>(businessId: string, run: (tx: TenantQuery) => Promise<T>): Promise<T>;
}

/**
 * One export for one business: take the lease, read a batch after the cursor,
 * register each run's copy, deliver, then advance the cursor or record the
 * gap and give the lease up. The read and the advance are separate
 * transactions and delivery is between them, so no transaction is open while
 * the target is asked; each body renews the lease first, and an export that
 * has lost it stops, `held`. The events owed again
 * (`owedSince`) go first, in bodies of at most `TRACE_BATCH` in the cursor's
 * order, the batch's own events with the last; one refused body stops the
 * rest, and the next export sends them all again.
 *
 * The read takes only events whose writing transaction is below its
 * snapshot's horizon, in transaction order (0090): every transaction below
 * the horizon has finished and any later write has a higher id, so an event
 * that commits late never lands behind the cursor. A long transaction
 * anywhere holds the export back until it ends; it never loses an event.
 */
export async function exportOnce(
  database: TraceDatabase,
  businessId: string,
  key: Buffer,
  deliver: Deliver,
): Promise<ExportOutcome> {
  const holder = randomUUID();
  const read = await database.withBusiness(businessId, async (tx) => {
    const cursor = await take(tx, holder);
    if (cursor === null) return null;
    const rows = await pending(tx, cursor);
    if (rows.length === 0) await release(tx, holder);
    for (const runId of new Set(rows.filter((row) => !row.past).map((row) => row.runId))) {
      // eslint-disable-next-line no-await-in-loop -- one registration per run, in order
      await registerTraceCopy(tx, runId);
    }
    const owed = await owedSince<Row>(tx, EVENT_CELLS, rows, cursor, TRACE_WINDOW_DAYS);
    const fresh = rows.filter((row) => !row.past);
    return { from: cursor, batch: rows, sent: bodiesOf(owed, fresh) };
  });
  if (read === null) return { kind: 'held' };
  const { from, batch, sent } = read;
  const last = batch.at(-1);
  if (last === undefined) return { kind: 'idle' };
  const renewed = async (at: string | null): Promise<string | null> =>
    await database.withBusiness(businessId, async (tx) => await renew(tx, holder, at));
  let { version } = from;
  let code: GapCode | null = null;
  let spans = 0;
  for (const body of sent) {
    // eslint-disable-next-line no-await-in-loop -- the lease before each body
    version = await renewed(version);
    if (version === null) return { kind: 'held' };
    spans += body.length;
    // eslint-disable-next-line no-await-in-loop -- one body after another, in the cursor's order
    code = await send(
      deliver,
      body.map((row) => spanOf(key, businessId, row)),
    );
    if (code !== null) break;
  }
  await database.withBusiness(businessId, async (tx) => {
    if (code === null) await advance(tx, last, holder, version);
    else await recordGap(tx, code, from, batch.length);
    await letGo(tx, holder, code);
  });
  return code === null ? { kind: 'delivered', spans } : { kind: 'gap', code, spans };
}

/**
 * One body. A body larger than a plain export's (`TRACE_BATCH`) that the
 * target refuses as too large goes again as two halves, in order: an owed
 * resend then asks no more of the target than a plain export does, and the
 * earliest span still leaves first.
 */
async function send(deliver: Deliver, spans: readonly TraceSpan[]): Promise<GapCode | null> {
  const code = gapOf(await deliver(otlp(spans)));
  if (code !== 'target_oversized_body' || spans.length <= TRACE_BATCH) return code;
  const half = Math.ceil(spans.length / 2);
  return (await send(deliver, spans.slice(0, half))) ?? (await send(deliver, spans.slice(half)));
}

/** The owed events in bodies of `TRACE_BATCH`, the batch's own (up to `TRACE_BATCH` more) with the last; none when both are empty. */
function bodiesOf(owed: readonly Row[], fresh: readonly Row[]): readonly (readonly Row[])[] {
  const bodies: (readonly Row[])[] = [];
  for (let at = 0; at < owed.length; at += TRACE_BATCH) {
    bodies.push(owed.slice(at, at + TRACE_BATCH));
  }
  const tail = [...(bodies.pop() ?? []), ...fresh];
  return tail.length === 0 ? bodies : [...bodies, tail];
}

/**
 * The batch after `from`, the cursor this export read: its gap, if it has one,
 * names the same. An event `past` the window is passed by the cursor, never
 * sent: retention would owe it a delete at once, and a confirmation covers only
 * such events, so a step back that re-reads them brings no trace back.
 */
async function pending(tx: TenantQuery, from: Cursor): Promise<readonly Pending[]> {
  return await tx.query<Pending>(
    `select ${EVENT_CELLS},
            ev.created_at < now() - make_interval(days => $5) as past
       from public.run_events ev
      where ev.business_id = $1
        and ev.tx < pg_snapshot_xmin(pg_current_snapshot())
        and ($3::xid8 is null or (ev.tx, ev.id) > ($3::xid8, $4::uuid))
      order by ev.tx, ev.id
      limit $2`,
    [tx.businessId, TRACE_BATCH, from.tx, from.id, TRACE_WINDOW_DAYS],
  );
}

function spanOf(key: Buffer, businessId: string, row: Row): TraceSpan {
  return traceSpan({
    traceId: derivedId(key, ['trace', businessId, row.runId], 32),
    spanId: derivedId(key, ['span', businessId, row.id], 16),
    ...cellsOf(row),
  });
}

async function registerTraceCopy(tx: TenantQuery, runId: string): Promise<void> {
  await tx.query(
    `insert into public.copy_registrations
       (business_id, id, copy_class, copy_key, invalidation_trigger, retention_class)
     values ($1, $2, 'diagnostic_trace', $3, 'client_erased', 'trace')
     on conflict (business_id, copy_class, copy_key) do nothing`,
    [tx.businessId, randomUUID(), `run:${runId}`],
  );
}

/**
 * The advance lands only while `holder` holds the lease, on the version it
 * last wrote; otherwise it changes nothing and the next read starts wherever
 * the row now is. Retention's step back (`sendAgain` in `trace-retention.ts`)
 * gives the row a new version: an export that read before it, and may have
 * delivered before the delete, never moves the cursor past the events the
 * step sends again. The row lock orders them; the version under it decides.
 */
async function advance(
  tx: TenantQuery,
  last: Row,
  holder: string,
  version: string | null,
): Promise<void> {
  await tx.query(
    `update public.trace_export_cursors c
        set after_tx = ev.tx, after_id = ev.id, updated_at = now()
       from public.run_events ev
      where c.business_id = $1 and ev.business_id = $1 and ev.id = $2
        and c.lease_holder = $3 and c.xmin = $4::xid`,
    [tx.businessId, last.id, holder, version],
  );
}

/**
 * A gap names the cursor its batch was read after, never the row as it is
 * now: another export may have advanced it while this one waited on the target.
 */
async function recordGap(
  tx: TenantQuery,
  code: GapCode,
  from: Cursor,
  events: number,
): Promise<void> {
  await tx.query(
    `insert into public.trace_export_gaps (business_id, id, code, from_tx, from_id, events)
     values ($1, $2, $3, $4::xid8, $5::uuid, $6)`,
    [tx.businessId, randomUUID(), code, from.tx, from.id, events],
  );
}
