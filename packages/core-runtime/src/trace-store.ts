// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: the trace store as retention reads it (`trace-retention.ts`). Only a
// read that finds nothing proves a delete landed. An owed run the export has
// sent an event of since its place is read by its earliest such event's span:
// the export sends an owed run again in bodies, earliest first, and a delete
// that lands between two of them leaves the trace there without that span.
// Reads the store does not answer, three in a row, end a pass's owed
// read-back; the runs they were are recorded, and the next pass reads every
// other owed run first (`owedAsks` in `trace-owed.ts`).

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import type { Delivered } from './trace-delivery.ts';
import { derivedId } from './trace-span.ts';

/** Unanswered reads in a row that end a pass's owed read-back: the store is not answering. */
export const UNANSWERED = 3;

/** The trace store as retention asks it: delete ids, then read one trace back, or with `spanId` one span of it. */
export interface ExpiryPorts {
  expire(traceIds: readonly string[]): Promise<Delivered>;
  present(traceId: string, spanId?: string): Promise<'absent' | 'present' | 'unknown'>;
}

/** A pass's owed read-back: each run's earliest sent owed event, the runs the store did not answer, and how many in a row. */
export interface Reading {
  readonly firsts: Map<string, string>;
  readonly unanswered: string[];
  quiet: number;
}

export const traceOf = (key: Buffer, businessId: string, runId: string): string =>
  derivedId(key, ['trace', businessId, runId], 32);

const spanOf = (key: Buffer, businessId: string, eventId: string): string =>
  derivedId(key, ['span', businessId, eventId], 16);

/** The runs a read finds gone; with `reading`, by their earliest sent owed span, until `UNANSWERED` unanswered reads in a row. */
export async function readBack(
  key: Buffer,
  businessId: string,
  ports: ExpiryPorts,
  runs: readonly string[],
  reading?: Reading,
): Promise<readonly string[]> {
  const gone: string[] = [];
  for (const runId of runs) {
    if (reading !== undefined && reading.quiet >= UNANSWERED) break;
    const first = reading?.firsts.get(runId);
    // eslint-disable-next-line no-await-in-loop -- one read at a time; the store is not hurried
    const read = await ports.present(
      traceOf(key, businessId, runId),
      first === undefined ? undefined : spanOf(key, businessId, first),
    );
    if (reading !== undefined) {
      reading.quiet = read === 'unknown' ? reading.quiet + 1 : 0;
      if (read === 'unknown') reading.unanswered.push(runId);
    }
    if (read === 'absent') gone.push(runId);
  }
  return gone;
}

/** The runs a pass's owed read-back could not read, on a batch row that confirms nothing. */
export async function unanswered(
  tx: TenantQuery,
  reading: Reading,
  windowDays: number,
): Promise<void> {
  await tx.query(
    `insert into public.trace_expiry_batches
       (business_id, id, window_days, runs, expired_run_ids, code, unanswered_run_ids)
     values ($1, $2, $3, $4, '{}', 'expiry_unconfirmed', $5::uuid[])`,
    [tx.businessId, randomUUID(), windowDays, reading.unanswered.length, reading.unanswered],
  );
}
