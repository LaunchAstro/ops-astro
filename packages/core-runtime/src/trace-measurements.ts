// SPDX-License-Identifier: AGPL-3.0-only

import { TRACE_OUTCOMES, TraceRefused, type TraceMeasurements } from './trace-span.ts';

export type { MeasuredTraceSpan, TraceMeasurements } from './trace-span.ts';

export interface MeasurementRow {
  readonly kind: string;
  readonly recordedOutcome: string | null;
  readonly modelCalls: number | null;
  readonly settledCalls: number | null;
}

const TERMINAL = new Set(['handed_back', 'child_handed_back', 'dropped']);

/**
 * Call counts at this event, within its business, run and lease. No unit counts are projected.
 * Bounded by the event's write instant, after its writer's locks: its transaction's start
 * can precede a call that settled while the writer waited.
 */
const WRITTEN = 'coalesce(ev.written_at, ev.created_at)';
export const MEASUREMENT_COLUMNS: string = `ev.detail ->> 'outcome' as "recordedOutcome",
  case when ev.kind in ('handed_back', 'child_handed_back', 'dropped') then
    (select count(*)::float8 from public.model_calls mc
      where mc.business_id = ev.business_id and mc.run_id = ev.run_id
        and mc.reservation_id = (select l.reservation_id from public.leases l
          where l.business_id = ev.business_id and l.id = ev.lease_id)
        and mc.lease_id = ev.lease_id and mc.accepted_at <= ${WRITTEN})
    else null end as "modelCalls",
  case when ev.kind in ('handed_back', 'child_handed_back', 'dropped') then
    (select count(*)::float8 from public.model_calls mc
      where mc.business_id = ev.business_id and mc.run_id = ev.run_id
        and mc.reservation_id = (select l.reservation_id from public.leases l
          where l.business_id = ev.business_id and l.id = ev.lease_id)
        and mc.lease_id = ev.lease_id and mc.accepted_at <= ${WRITTEN}
        and mc.state = 'settled' and mc.ended_at <= ${WRITTEN})
    else null end as "settledCalls"`;

function count(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TraceRefused(field);
  return value;
}

/** Closed, atomic measurements: non-terminal means no outcome and no invented zero usage. */
export function traceMeasurements(input: Readonly<Record<string, unknown>>): TraceMeasurements {
  if (Object.keys(input).toSorted().join() !== 'modelCalls,outcome,settledCalls')
    throw new TraceRefused('a field outside the measurement allowlist');
  if (input['outcome'] === null) {
    if (input['modelCalls'] !== null) throw new TraceRefused('modelCalls');
    if (input['settledCalls'] !== null) throw new TraceRefused('settledCalls');
    return Object.freeze({ outcome: null, modelCalls: null, settledCalls: null });
  }
  const outcome = TRACE_OUTCOMES.find((candidate) => candidate === input['outcome']);
  if (outcome === undefined) throw new TraceRefused('outcome');
  const modelCalls = count(input['modelCalls'], 'modelCalls');
  const settledCalls = count(input['settledCalls'], 'settledCalls');
  if (settledCalls > modelCalls) throw new TraceRefused('settledCalls');
  return Object.freeze({ outcome, modelCalls, settledCalls });
}

/** Raw event detail is never exported; an unrecognised terminal value is unknown. */
export function projectMeasurements(row: MeasurementRow): TraceMeasurements {
  if (!TERMINAL.has(row.kind))
    return traceMeasurements({ outcome: null, modelCalls: null, settledCalls: null });
  const recorded = ['completed', 'failed', 'partial'].find(
    (candidate) => candidate === row.recordedOutcome,
  );
  return traceMeasurements({
    outcome: row.kind === 'dropped' ? 'dropped' : (recorded ?? 'unknown'),
    modelCalls: row.modelCalls,
    settledCalls: row.settledCalls,
  });
}
