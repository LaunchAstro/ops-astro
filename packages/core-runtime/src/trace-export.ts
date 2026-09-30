// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: the diagnostic trace export. A run's durable events leave as
// timings, counts and codes, never a sentence, to a trace target an operator
// reads. The exporter is outside the execution path: it reads `run_events` by
// its own cursor (0046), on its own transactions, and nothing a run does
// waits on it or reads what it wrote. With the exporter stopped, killed or
// failing, every run settles as before; the durable record is the buffer.
//
// What a span may hold, and how its ids are derived: `trace-span.ts`.
//
// **Delivery is a port** (`Deliver`): the composition root hands the exporter
// custody's egress, which names the target's origin itself, refuses redirects
// and bounds the reply by time and bytes. Anything short of a 2xx JSON reply
// is recorded as a gap with a fixed code and the cursor stays where it was;
// an export with no reachable target is never reported as success.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import {
  TRACE_ERRORS,
  TRANSFORM_VERSION,
  derivedId,
  otlp,
  traceSpan,
  type TraceSpan,
} from './trace-span.ts';

/** What delivery answers: custody's `Outbound`, narrowed to what the exporter reads. */
export type Delivered =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly fault: string; readonly status: number | null };

export type Deliver = (body: string) => Promise<Delivered>;

export type GapCode =
  | 'target_unreachable'
  | 'target_redirect'
  | 'target_timeout'
  | 'target_oversized_reply'
  | 'target_malformed_reply'
  | 'target_refused'
  | 'target_forbidden';

export type ExportOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'delivered'; readonly spans: number }
  | { readonly kind: 'gap'; readonly code: GapCode; readonly spans: number };

/** The most events one export sends. */
export const TRACE_BATCH = 100;

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
 * no transaction is open while the target is asked.
 *
 * The read takes only events whose writing transaction is below its
 * snapshot's horizon, in transaction order (0047): every transaction below
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
  const batch = await database.withBusiness(businessId, async (tx) => {
    const rows = await pending(tx);
    for (const runId of new Set(rows.map((row) => row.runId))) {
      // eslint-disable-next-line no-await-in-loop -- one registration per run, in order
      await registerTraceCopy(tx, runId);
    }
    return rows;
  });
  const last = batch.at(-1);
  if (last === undefined) return { kind: 'idle' };
  const spans = batch.map((row) => spanOf(key, businessId, row));
  const answer = await deliver(otlp(spans));
  const code = gapOf(answer);
  await database.withBusiness(businessId, async (tx) => {
    if (code === null) await advance(tx, last);
    else await recordGap(tx, code, batch.length);
  });
  return code === null
    ? { kind: 'delivered', spans: spans.length }
    : { kind: 'gap', code, spans: spans.length };
}

async function pending(tx: TenantQuery): Promise<readonly Row[]> {
  return await tx.query<Row>(
    `select ev.id, ev.run_id as "runId", ev.kind, ev.position::float8 as position,
            (extract(epoch from ev.created_at) * 1000)::float8 as "atMs",
            (select (extract(epoch from prev.created_at) * 1000)::float8
               from public.run_events prev
              where prev.business_id = ev.business_id and prev.run_id = ev.run_id
                and prev.position < ev.position
              order by prev.position desc limit 1) as "previousMs",
            ev.detail ->> 'cause' as cause
       from public.run_events ev
       left join public.trace_export_cursors c on c.business_id = ev.business_id
      where ev.business_id = $1
        and ev.tx < pg_snapshot_xmin(pg_current_snapshot())
        and (c.after_tx is null or (ev.tx, ev.id) > (c.after_tx, c.after_id))
      order by ev.tx, ev.id
      limit $2`,
    [tx.businessId, TRACE_BATCH],
  );
}

function spanOf(key: Buffer, businessId: string, row: Row): TraceSpan {
  const startedAtMs = Math.floor(row.atMs);
  return traceSpan({
    traceId: derivedId(key, ['trace', businessId, row.runId], 32),
    spanId: derivedId(key, ['span', businessId, row.id], 16),
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
  });
}

const FAULT_GAP: Readonly<Record<string, GapCode>> = {
  redirect: 'target_redirect',
  timeout: 'target_timeout',
  too_large: 'target_oversized_reply',
  forbidden: 'target_forbidden',
  unlisted: 'target_forbidden',
  bad_path: 'target_forbidden',
  status: 'target_refused',
  network: 'target_unreachable',
};

/** Null for a landed delivery; otherwise the gap's fixed code. Retention reads its deletes the same way. */
export function gapOf(answer: Delivered): GapCode | null {
  if (!answer.ok) return FAULT_GAP[answer.fault] ?? 'target_unreachable';
  if (answer.status < 200 || answer.status > 299) return 'target_refused';
  try {
    const parsed: unknown = JSON.parse(answer.body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? null
      : 'target_malformed_reply';
  } catch {
    return 'target_malformed_reply';
  }
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
 * Forward only: two exports at once may read the same batch, and the slower
 * one must not move the cursor back past what the faster one delivered. The
 * upsert's row lock orders them; the comparison under it keeps the later.
 */
async function advance(tx: TenantQuery, last: Row): Promise<void> {
  await tx.query(
    `insert into public.trace_export_cursors (business_id, after_tx, after_id)
     select $1, tx, id from public.run_events where business_id = $1 and id = $2
     on conflict (business_id) do update
       set after_tx = excluded.after_tx, after_id = excluded.after_id, updated_at = now()
       where trace_export_cursors.after_tx is null
          or (trace_export_cursors.after_tx, trace_export_cursors.after_id)
             < (excluded.after_tx, excluded.after_id)`,
    [tx.businessId, last.id],
  );
}

async function recordGap(tx: TenantQuery, code: GapCode, events: number): Promise<void> {
  await tx.query(
    `insert into public.trace_export_gaps (business_id, id, code, from_tx, from_id, events)
     select $1, $2, $3, c.after_tx, c.after_id, $4
       from (select 1) one
       left join public.trace_export_cursors c on c.business_id = $1`,
    [tx.businessId, randomUUID(), code, events],
  );
}
