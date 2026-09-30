// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: what a diagnostic trace may hold, and nothing else.
//
// **The span is a typed allowlist** (`traceSpan`). Every field is a hex
// identifier, a whole number or a value from a closed list, so no cell can
// hold a sentence; a value outside the list is refused, never truncated, and
// the refusal names the field, never the value. Content, URLs and client
// site lists have nowhere to go.
//
// **Identifiers are derived** with a keyed function (HMAC-SHA256 under the
// installation's trace key) from the business and the run or event, so a
// replay sends the same ids and the target dedupes it, and no registry maps
// a trace back to a record: only the key holder can recompute one.

import { createHmac } from 'node:crypto';

/** The run events a trace may describe; the kinds `run-events.ts` writes. */
export const TRACE_STAGES = ['claimed', 'handed_back', 'dropped', 'reactivated'] as const;
export type TraceStage = (typeof TRACE_STAGES)[number];

/** The bounded error codes a span may carry: a drop's cause, never its words. */
export const TRACE_ERRORS = ['provider_unavailable', 'connection_lost', 'worker_lost'] as const;
export type TraceError = (typeof TRACE_ERRORS)[number];

/** The transform's version: a change to what a span holds changes this. */
export const TRANSFORM_VERSION = 1;

export interface TraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly stage: TraceStage;
  readonly transformVersion: number;
  readonly startedAtMs: number;
  /** From the run's previous event to this one; null for the first. */
  readonly durationMs: number | null;
  /** The event's place in its task's order. */
  readonly sequence: number;
  readonly errorCode: TraceError | null;
}

const HEX32 = /^[0-9a-f]{32}$/u;
const HEX16 = /^[0-9a-f]{16}$/u;

/** The allowlist: every field checked, a value outside it refused. */
export function traceSpan(input: Readonly<Record<string, unknown>>): TraceSpan {
  const keys = Object.keys(input).toSorted();
  const allowed = [
    'durationMs',
    'errorCode',
    'sequence',
    'spanId',
    'stage',
    'startedAtMs',
    'traceId',
    'transformVersion',
  ];
  if (keys.join() !== allowed.join()) throw new TraceRefused('a field outside the allowlist');
  const { traceId, spanId, stage, transformVersion, startedAtMs, durationMs, sequence, errorCode } =
    input;
  if (typeof traceId !== 'string' || !HEX32.test(traceId)) throw new TraceRefused('traceId');
  if (typeof spanId !== 'string' || !HEX16.test(spanId)) throw new TraceRefused('spanId');
  if (!(TRACE_STAGES as readonly unknown[]).includes(stage)) throw new TraceRefused('stage');
  if (transformVersion !== TRANSFORM_VERSION) throw new TraceRefused('transformVersion');
  if (!whole(startedAtMs)) throw new TraceRefused('startedAtMs');
  if (durationMs !== null && !whole(durationMs)) throw new TraceRefused('durationMs');
  if (!whole(sequence)) throw new TraceRefused('sequence');
  if (errorCode !== null && !(TRACE_ERRORS as readonly unknown[]).includes(errorCode))
    throw new TraceRefused('errorCode');
  return Object.freeze({
    traceId,
    spanId,
    stage: stage as TraceStage,
    transformVersion,
    startedAtMs: startedAtMs as number,
    durationMs: durationMs as number | null,
    sequence: sequence as number,
    errorCode: errorCode as TraceError | null,
  });
}

/** A value the allowlist does not hold. Names the field, never the value. */
export class TraceRefused extends Error {
  constructor(field: string) {
    super(`trace: refused ${field}`);
    this.name = 'TraceRefused';
  }
}

function whole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A keyed id: the first `hex` characters of HMAC-SHA256(key, parts). */
export function derivedId(key: Buffer, parts: readonly string[], hex: 32 | 16): string {
  return createHmac('sha256', key).update(parts.join('\n')).digest('hex').slice(0, hex);
}

/** OTLP/HTTP JSON: one resource, one scope, a span per event, attributes from the allowlist only. */
/** Milliseconds as OTLP's nanoseconds, as a string. */
const nanos = (ms: number): string => `${String(ms)}000000`;

export function otlp(spans: readonly TraceSpan[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'ops-astro' } }] },
        scopeSpans: [
          {
            scope: { name: 'ops-astro.trace', version: String(TRANSFORM_VERSION) },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              name: span.stage,
              kind: 1,
              startTimeUnixNano: nanos(span.startedAtMs - (span.durationMs ?? 0)),
              endTimeUnixNano: nanos(span.startedAtMs),
              attributes: [
                { key: 'stage', value: { stringValue: span.stage } },
                { key: 'sequence', value: { intValue: String(span.sequence) } },
                ...(span.errorCode === null
                  ? []
                  : [{ key: 'error.code', value: { stringValue: span.errorCode } }]),
              ],
            })),
          },
        ],
      },
    ],
  });
}
