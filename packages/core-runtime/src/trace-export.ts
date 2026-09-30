// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: the diagnostic trace export. Signatures only: the tests come first.

import type { TenantQuery } from '../../core-records/src/index.ts';

export const TRACE_STAGES = ['claimed', 'handed_back', 'dropped', 'reactivated'] as const;
export type TraceStage = (typeof TRACE_STAGES)[number];
export const TRACE_ERRORS = ['provider_unavailable', 'connection_lost', 'worker_lost'] as const;
export type TraceError = (typeof TRACE_ERRORS)[number];
export const TRANSFORM_VERSION = 1;

export interface TraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly stage: TraceStage;
  readonly transformVersion: number;
  readonly startedAtMs: number;
  readonly durationMs: number | null;
  readonly sequence: number;
  readonly errorCode: TraceError | null;
}

export type Delivered =
  | { readonly ok: true; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly fault: string; readonly status: number | null };
export type Deliver = (body: string) => Promise<Delivered>;
export type GapCode = string;
export type ExportOutcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'delivered'; readonly spans: number }
  | { readonly kind: 'gap'; readonly code: GapCode; readonly spans: number };
export interface TraceDatabase {
  withBusiness<T>(businessId: string, run: (tx: TenantQuery) => Promise<T>): Promise<T>;
}

export function traceSpan(_input: Readonly<Record<string, unknown>>): TraceSpan {
  throw new Error('AW-13: not built');
}
export function derivedId(_key: Buffer, _parts: readonly string[], _hex: 32 | 16): string {
  throw new Error('AW-13: not built');
}
export function otlp(_spans: readonly TraceSpan[]): string {
  throw new Error('AW-13: not built');
}
export function exportOnce(
  _database: TraceDatabase,
  _businessId: string,
  _key: Buffer,
  _deliver: Deliver,
): Promise<ExportOutcome> {
  return Promise.reject(new Error('AW-13: not built'));
}
