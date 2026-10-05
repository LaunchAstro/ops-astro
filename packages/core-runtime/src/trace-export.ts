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

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { gapOf, type Deliver, type GapCode } from './trace-delivery.ts';
import { owedSince } from './trace-owed.ts';
import {
  TRACE_ERRORS,
  TRANSFORM_VERSION,
  derivedId,
  otlp,
  traceCells,
  traceSpan,
  type TraceCells,
  type TraceSpan,
} from './trace-span.ts';

export type ExportOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'delivered'; readonly spans: number }
  | { readonly kind: 'gap'; readonly code: GapCode; readonly spans: number };

/** The most events one export reads, and the most owed events one body sends again. */
export const TRACE_BATCH = 100;

/** The trace window, in days (contract 7.5): an event older than it when read is never sent. */
export const TRACE_WINDOW_DAYS = 30;

type Pending = Row & { readonly past: boolean };

interface Row {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly position: number;
  readonly atMs: number;
  readonly previousMs: number | null;
  readonly cause: string | null;
}

/** The database side the exporter needs: one business's tenant transactions. */
export interface TraceDatabase {
  withBusiness<T>(businessId: string, run: (tx: TenantQuery) => Promise<T>): Promise<T>;
}

/**
 * One export for one business: read a batch after the cursor, register each
 * run's copy, deliver, then advance the cursor or record the gap. The read
 * and the advance are separate transactions and delivery is between them, so
 * no transaction is open while the target is asked. The events owed again
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
  const { from, batch, sent } = await database.withBusiness(businessId, async (tx) => {
    const cursor = await cursorOf(tx);
    const rows = await pending(tx, cursor);
    for (const runId of new Set(rows.filter((row) => !row.past).map((row) => row.runId))) {
      // eslint-disable-next-line no-await-in-loop -- one registration per run, in order
      await registerTraceCopy(tx, runId);
    }
    const owed = await owedSince<Row>(tx, EVENT_CELLS, rows, cursor, TRACE_WINDOW_DAYS);
    const fresh = rows.filter((row) => !row.past);
    return { from: cursor, batch: rows, sent: bodiesOf(owed, fresh) };
  });
  const last = batch.at(-1);
  if (last === undefined) return { kind: 'idle' };
  let code: GapCode | null = null;
  let spans = 0;
  for (const body of sent) {
    spans += body.length;
    // eslint-disable-next-line no-await-in-loop -- one body after another, in the cursor's order
    code = await send(
      deliver,
      body.map((row) => spanOf(key, businessId, row)),
    );
    if (code !== null) break;
  }
  await database.withBusiness(businessId, async (tx) => {
    if (code === null) await advance(tx, last, from.version);
    else await recordGap(tx, code, from, batch.length);
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

/** What a span is made of, per event `ev`: the export's read and `trace.read`'s. */
const EVENT_CELLS = `ev.id, ev.run_id as "runId", ev.kind, ev.position::float8 as position,
            (extract(epoch from ev.created_at) * 1000)::float8 as "atMs",
            (select (extract(epoch from prev.created_at) * 1000)::float8
               from public.run_events prev
              where prev.business_id = ev.business_id and prev.run_id = ev.run_id
                and prev.position < ev.position
              order by prev.position desc limit 1) as "previousMs",
            ev.detail ->> 'cause' as cause`;

/**
 * The cursor as one read saw it: its place `(tx, id)`, both null before the
 * first advance, and its row's version (`xmin`), null before the row exists.
 * Every write to the row gives it a new version.
 */
export interface Cursor {
  readonly tx: string | null;
  readonly id: string | null;
  readonly version: string | null;
}

async function cursorOf(tx: TenantQuery): Promise<Cursor> {
  const [row] = await tx.query<Cursor>(
    `select after_tx::text as tx, after_id as id, xmin::text as version
       from public.trace_export_cursors where business_id = $1`,
    [tx.businessId],
  );
  return row ?? { tx: null, id: null, version: null };
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

/** An event's cells, unchecked: `traceSpan` and `traceCells` hold them to the allowlist. */
function cellsOf(row: Row): Readonly<Record<string, unknown>> {
  const startedAtMs = Math.floor(row.atMs);
  return {
    stage: row.kind,
    transformVersion: TRANSFORM_VERSION,
    startedAtMs,
    durationMs:
      row.previousMs === null ? null : Math.max(0, startedAtMs - Math.floor(row.previousMs)),
    sequence: row.position,
    errorCode:
      row.cause !== null && (TRACE_ERRORS as readonly string[]).includes(row.cause)
        ? row.cause
        : null,
  };
}

/** The most events one `trace.read` returns; `complete` says whether it reached the end. */
export const TRACE_READ_LIMIT = 1_000;

/** A span as `trace.read` shows it: the allowlist's cells, its run, and whether it has left. */
export type ReadSpan = TraceCells & { readonly runId: string; readonly exported: boolean };

/**
 * One task's trace as an operator reads it (AW-13 readers, `trace.read`): each
 * event of its runs as the export sends it, less the two ids only the
 * exporter's key derives, and whether it is behind the cursor. The grant is
 * asked before this, by the read's row (`operations:read`, then the task's own
 * read); the task is the query's, under the business's tenancy.
 */
export async function readTaskTrace(
  tx: TenantQuery,
  taskId: string,
): Promise<{ readonly spans: readonly ReadSpan[]; readonly complete: boolean }> {
  const rows = await tx.query<Row & { readonly exported: boolean }>(
    `select ${EVENT_CELLS},
            coalesce((ev.tx, ev.id) <= (c.after_tx, c.after_id), false) as exported
       from public.run_events ev
       join public.planned_runs run on run.business_id = ev.business_id and run.id = ev.run_id
       left join public.trace_export_cursors c on c.business_id = ev.business_id
      where ev.business_id = $1 and run.task_id = $2
      order by ev.position, ev.id
      limit $3`,
    [tx.businessId, taskId, TRACE_READ_LIMIT + 1],
  );
  return {
    spans: rows
      .slice(0, TRACE_READ_LIMIT)
      .map((row): ReadSpan =>
        Object.assign({ runId: row.runId, exported: row.exported }, traceCells(cellsOf(row))),
      ),
    complete: rows.length <= TRACE_READ_LIMIT,
  };
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
 * The advance lands only on the cursor version its batch was read under;
 * otherwise it changes nothing and the next read starts wherever the row now
 * is. Two exports that read the same batch: the slower never moves the
 * cursor back. Retention's step back (`sendAgain` in `trace-retention.ts`): an
 * export that read before it, and may have delivered before the delete, never
 * moves the cursor past the events the step sends again. The row lock orders
 * them; the version under it decides.
 */
async function advance(tx: TenantQuery, last: Row, version: string | null): Promise<void> {
  await tx.query(
    `insert into public.trace_export_cursors (business_id, after_tx, after_id)
     select $1, tx, id from public.run_events where business_id = $1 and id = $2
     on conflict (business_id) do update
       set after_tx = excluded.after_tx, after_id = excluded.after_id, updated_at = now()
       where trace_export_cursors.xmin = $3::xid`,
    [tx.businessId, last.id, version],
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
