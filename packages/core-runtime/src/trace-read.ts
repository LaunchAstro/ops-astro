// SPDX-License-Identifier: AGPL-3.0-only
//
// What a run event is as a span's cells, shared by the export
// (`trace-export.ts`) and `trace.read`, whose read is here too (moved out of
// `trace-export.ts` whole for its line cap; it re-exports the read).

import { readableNow, type TenantQuery } from '../../core-records/src/index.ts';
import { TRACE_ERRORS, TRANSFORM_VERSION, traceCells, type TraceCells } from './trace-span.ts';

/** One run event as the export and the read select it (`EVENT_CELLS`). */
export interface Row {
  readonly id: string;
  readonly runId: string;
  readonly kind: string;
  readonly position: number;
  readonly atMs: number;
  readonly previousMs: number | null;
  readonly cause: string | null;
}

/** What a span is made of, per event `ev`: the export's read and `trace.read`'s. */
export const EVENT_CELLS = `ev.id, ev.run_id as "runId", ev.kind, ev.position::float8 as position,
            (extract(epoch from ev.created_at) * 1000)::float8 as "atMs",
            (select (extract(epoch from prev.created_at) * 1000)::float8
               from public.run_events prev
              where prev.business_id = ev.business_id and prev.run_id = ev.run_id
                and prev.position < ev.position
              order by prev.position desc limit 1) as "previousMs",
            ev.detail ->> 'cause' as cause`;

/** An event's cells, unchecked: `traceSpan` and `traceCells` hold them to the allowlist. */
export function cellsOf(row: Row): Readonly<Record<string, unknown>> {
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
 * One task's trace as an operator reads it (AW-13, `trace.read`): each run event as the export
 * sends it, less the two ids only the exporter's key derives, and whether it is behind the cursor.
 * `operations:read` is asked before, by the read's row; the task's own read is asked here, in the
 * statement reading the events (`readableNow`), and null answers a task `personId` cannot read now.
 */
export async function readTaskTrace(
  tx: TenantQuery,
  taskId: string,
  personId: string,
): Promise<{ readonly spans: readonly ReadSpan[]; readonly complete: boolean } | null> {
  const rows = await tx.query<
    Omit<Row, 'id'> & { readonly id: string | null; readonly exported: boolean }
  >(
    `select ${EVENT_CELLS},
            coalesce((ev.tx, ev.id) <= (c.after_tx, c.after_id), false) as exported
       from public.records r
       left join (public.run_events ev
                  join public.planned_runs run
                    on run.business_id = ev.business_id and run.id = ev.run_id)
         on ev.business_id = r.business_id and run.task_id = r.id
       left join public.trace_export_cursors c on c.business_id = r.business_id
      where r.business_id = $1 and r.id = $2 and ${readableNow('$4::uuid', "'infinity'")}
      order by ev.position, ev.id
      limit $3`,
    [tx.businessId, taskId, TRACE_READ_LIMIT + 1, personId],
  );
  if (rows.length === 0) return null;
  const events = rows.flatMap((row) => (row.id === null ? [] : [{ ...row, id: row.id }]));
  return {
    spans: events
      .slice(0, TRACE_READ_LIMIT)
      .map((row): ReadSpan =>
        Object.assign({ runId: row.runId, exported: row.exported }, traceCells(cellsOf(row))),
      ),
    complete: events.length <= TRACE_READ_LIMIT,
  };
}
