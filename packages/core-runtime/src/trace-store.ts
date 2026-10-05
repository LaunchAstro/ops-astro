// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: the trace store as retention reads it (`trace-retention.ts`). Only a
// read that finds nothing proves a delete landed. An owed run the export has
// sent events of since its place is read by each such event's span, newest
// first, until one is not there: a delete that lands between two bodies of a
// resend, or a body sent before the delete and stored after it (a stalled or
// timed-out export's), leaves the trace there without some of them. Once a
// delete has landed the trace only grows until the run is sent again, so a
// span it took stays missing for every later read. A read the store does
// not answer does not stop the run's: an older span may answer absent.
// Reads the store does not answer, three in a row, end a pass's owed
// read-back. A pass that leaves a run unanswered records the runs it read,
// those it had no answer for with where their read stopped (the first
// unanswered span after the last answered one, or, when none answered, the
// span after the one the read began at); a run read after the pass's other
// reads with nothing answered is not recorded and keeps its turn. The next
// pass reads the runs it reached least lately first, an unanswered run from
// where it stopped
// (`owedAsks` in `trace-owed.ts`).

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

/**
 * A pass's owed read-back: each run's sent owed events and where its last
 * read stopped, the runs the store answered, those it did not with the event
 * each stopped at (aligned), those it left (read after the pass's other
 * reads with nothing answered), how many reads and how many unanswered in a row.
 */
export interface Reading {
  readonly sent: Map<string, readonly string[]>;
  readonly resume: Map<string, string>;
  readonly answered: string[];
  readonly unanswered: string[];
  readonly resumes: (string | null)[];
  readonly left: string[];
  reads: number;
  quiet: number;
}

/** A pass's reading before its first read. */
export const freshReading = (): Reading => ({
  sent: new Map(),
  resume: new Map(),
  answered: [],
  unanswered: [],
  resumes: [],
  left: [],
  reads: 0,
  quiet: 0,
});

/** Whether a pass's reading has a run to record: one unanswered, or one it left. */
export const unsettled = (reading: Reading): boolean =>
  reading.unanswered.length > 0 || reading.left.length > 0;

/** One run's read: how it ended, whether any span answered, its first unanswered span and the one after its last answer. */
interface Seen {
  read: 'absent' | 'present' | 'unknown';
  heard: boolean;
  first: string | undefined;
  streak: string | undefined;
}

export const traceOf = (key: Buffer, businessId: string, runId: string): string =>
  derivedId(key, ['trace', businessId, runId], 32);

const spanOf = (key: Buffer, businessId: string, eventId: string): string =>
  derivedId(key, ['span', businessId, eventId], 16);

/**
 * The runs a read finds gone; with `reading`, by each sent owed span from
 * where the run's last read stopped, until `UNANSWERED` unanswered reads in a
 * row (`settle` records each run).
 */
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
    const late = (reading?.reads ?? 0) > 0;
    const order = from(reading, runId);
    const seen: Seen = { read: 'present', heard: false, first: undefined, streak: undefined };
    for (const eventId of order) {
      if (reading !== undefined && reading.quiet >= UNANSWERED) break;
      // eslint-disable-next-line no-await-in-loop -- one read at a time; the store is not hurried
      const answer = await ports.present(
        traceOf(key, businessId, runId),
        eventId === undefined ? undefined : spanOf(key, businessId, eventId),
      );
      if (reading !== undefined) {
        reading.reads += 1;
        reading.quiet = answer === 'unknown' ? reading.quiet + 1 : 0;
      }
      if (answer === 'absent') {
        seen.read = 'absent';
        break;
      }
      if (answer === 'unknown') {
        seen.read = 'unknown';
        seen.first ??= eventId;
        seen.streak ??= eventId;
      } else {
        seen.heard = true;
        seen.streak = undefined;
      }
    }
    if (seen.read === 'absent') gone.push(runId);
    if (reading !== undefined) settle(reading, runId, seen, late, order);
  }
  return gone;
}

/**
 * Records one run's read. A run with an unanswered span and none absent is
 * left when nothing of it answered after the pass's other reads (the
 * allowance may be spent): it keeps its turn and where it stopped, so it goes
 * first next pass. Otherwise it is unanswered, and stops at the first
 * unanswered span after the last one the store answered; when it answered
 * none, at the span after the one its read began at. Each read moves on, and
 * past no span the store would have answered.
 */
function settle(
  reading: Reading,
  runId: string,
  seen: Seen,
  late: boolean,
  order: readonly (string | undefined)[],
): void {
  if (seen.read !== 'unknown') reading.answered.push(runId);
  else if (!seen.heard && late) reading.left.push(runId);
  else {
    reading.unanswered.push(runId);
    reading.resumes.push((seen.heard ? (seen.streak ?? seen.first) : order[1]) ?? order[0] ?? null);
  }
}

/** The run's sent owed events from where its last read stopped, round to it; the trace alone when none. */
function from(reading: Reading | undefined, runId: string): readonly (string | undefined)[] {
  const sent = reading?.sent.get(runId);
  if (sent === undefined) return [undefined];
  const at = sent.indexOf(reading?.resume.get(runId) ?? '');
  return at > 0 ? [...sent.slice(at), ...sent.slice(0, at)] : sent;
}

/** The runs a pass's owed read-back read, answered or not, on a batch row that confirms nothing. */
export async function recordReading(
  tx: TenantQuery,
  reading: Reading,
  windowDays: number,
): Promise<void> {
  await tx.query(
    `insert into public.trace_expiry_batches
       (business_id, id, window_days, runs, expired_run_ids, code, unanswered_run_ids,
        read_run_ids, resume_ids)
     values ($1, $2, $3, $4, '{}', 'expiry_unconfirmed', $5::uuid[], $6::uuid[], $7::uuid[])`,
    [
      tx.businessId,
      randomUUID(),
      windowDays,
      reading.unanswered.length + reading.answered.length,
      reading.unanswered,
      reading.answered,
      reading.resumes,
    ],
  );
}
