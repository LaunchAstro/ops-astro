// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: trace retention. Not built yet.

import type { Delivered, TraceDatabase } from './trace-export.ts';

/** The trace window, in days (contract 7.5). */
export const TRACE_WINDOW_DAYS = 30;
/** The deletion endpoint's cap on ids per call. */
export const EXPIRY_PAGE = 1_000;

/** The trace store as retention asks it: delete ids, then read one back. */
export interface ExpiryPorts {
  expire(traceIds: readonly string[]): Promise<Delivered>;
  present(traceId: string): Promise<'absent' | 'present' | 'unknown'>;
}

export interface RetentionBatch {
  readonly runs: number;
  readonly confirmed: number;
  readonly code: string | null;
}

export async function expireOnce(
  _database: TraceDatabase,
  _businessId: string,
  _key: Buffer,
  _ports: ExpiryPorts,
  _options: { readonly windowDays?: number; readonly page?: number } = {},
): Promise<readonly RetentionBatch[]> {
  return await Promise.reject(new Error('expireOnce: not built'));
}
