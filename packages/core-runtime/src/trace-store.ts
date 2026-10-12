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
//
// Every read of one deployment pass, every business's, is counted by one
// budget (`PassBudget`): no read after `READS_PER_PASS` reads, `UNANSWERED`
// unanswered in a row, or the deadline, and a 429 spends it at once. A pass
// records the runs it read and where each unanswered one stopped (`settle`);
// the next reads the runs it reached least lately first (`owedAsks` in
// `trace-owed.ts`). Each read-back also records each run's result, absent,
// present or unread, with its pass and turn: a run is confirmed gone only on
// absences in two turns in a row (`absentHistory`), as one 404 may be a span
// not yet ingested.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import type { Delivered } from './trace-delivery.ts';
import { derivedId } from './trace-span.ts';

/** Unanswered reads in a row that end a pass's reads: the store is not answering. */
export const UNANSWERED = 3;

/** Reads one deployment pass may make, every business's together. */
export const READS_PER_PASS = 1_000;

/** How long after its start a pass may still begin a read. */
export const PASS_DEADLINE_MS: number = 15 * 60_000;

/** A read's answer: `limited` is the store saying its allowance is spent (429). */
export type Answer = 'absent' | 'present' | 'unknown' | 'limited';

/** The trace store as retention asks it: delete ids, then read one trace back, or with `spanId` one span of it. */
export interface ExpiryPorts {
  expire(traceIds: readonly string[]): Promise<Delivered>;
  present(traceId: string, spanId?: string): Promise<Answer>;
}

/** One deployment pass's reads: its id, reads made, unanswered in a row, limit and deadline (ms). */
export interface PassBudget {
  readonly id: string;
  reads: number;
  quiet: number;
  readonly limit: number;
  readonly deadline: number;
}

/** A pass's budget before its first read. */
export const passBudget = (
  limit: number = READS_PER_PASS,
  deadline: number = Date.now() + PASS_DEADLINE_MS,
): PassBudget => ({ id: randomUUID(), reads: 0, quiet: 0, limit, deadline });

/** Whether the pass may read no more: its reads spent, the store silent, or past its deadline. */
export const spent = (budget: PassBudget): boolean =>
  budget.reads >= budget.limit || budget.quiet >= UNANSWERED || Date.now() >= budget.deadline;

/** One business's turn of a pass: the pass, the turn's number, the window's cutoff it judges by. */
export interface Turn {
  readonly passId: string;
  readonly seq: string;
  readonly cutoff: string;
  readonly windowDays: number;
}

/**
 * A pass's read-back: each run's sent owed events and where its last read
 * stopped, the runs the store answered, those it did not with the event each
 * stopped at (aligned), those it left (nothing answered, after the pass's
 * other reads or with the budget spent), and the pass's budget.
 */
export interface Reading {
  readonly sent: Map<string, readonly string[]>;
  readonly resume: Map<string, string>;
  readonly answered: string[];
  readonly unanswered: string[];
  readonly resumes: (string | null)[];
  readonly left: string[];
  readonly budget: PassBudget;
}

/** A pass's reading before its first read. */
export const freshReading = (budget: PassBudget = passBudget()): Reading => ({
  budget,
  sent: new Map(),
  resume: new Map(),
  answered: [],
  unanswered: [],
  resumes: [],
  left: [],
});

/** Whether a pass's reading has a run to record: one unanswered, or one it left. */
export const unsettled = (reading: Reading): boolean =>
  reading.unanswered.length > 0 || reading.left.length > 0;

/** One run's read: its end, any answer, a budget stop, its first unanswered span, the one after its last answer. */
interface Seen {
  read: 'absent' | 'present' | 'unknown';
  heard: boolean;
  stopped: boolean;
  first: string | undefined;
  streak: string | undefined;
}

export const traceOf = (key: Buffer, businessId: string, runId: string): string =>
  derivedId(key, ['trace', businessId, runId], 32);

const spanOf = (key: Buffer, businessId: string, eventId: string): string =>
  derivedId(key, ['span', businessId, eventId], 16);

/**
 * The runs a read finds gone, by each sent owed span from where the run's
 * last read stopped, while the pass's budget lasts (`settle` records each run).
 */
export async function readBack(
  key: Buffer,
  businessId: string,
  ports: ExpiryPorts,
  runs: readonly string[],
  reading: Reading,
): Promise<readonly string[]> {
  const gone: string[] = [];
  for (const runId of runs) {
    const late = reading.budget.reads > 0;
    const order = from(reading, runId);
    const read = (eventId: string | undefined): Promise<Answer> =>
      ports.present(
        traceOf(key, businessId, runId),
        eventId === undefined ? undefined : spanOf(key, businessId, eventId),
      );
    // eslint-disable-next-line no-await-in-loop -- one run at a time; the store is not hurried
    const seen = await readRun(read, order, reading.budget);
    if (seen.read === 'absent') gone.push(runId);
    settle(reading, runId, seen, late, order);
  }
  return gone;
}

/** One run's spans read in `order` until one is absent or the budget is spent. */
async function readRun(
  read: (eventId: string | undefined) => Promise<Answer>,
  order: readonly (string | undefined)[],
  budget: PassBudget,
): Promise<Seen> {
  const seen: Seen = {
    read: 'present',
    heard: false,
    stopped: false,
    first: undefined,
    streak: undefined,
  };
  for (const eventId of order) {
    // eslint-disable-next-line no-await-in-loop -- one read at a time; the store is not hurried
    const answer = spent(budget) ? 'unread' : await read(eventId);
    if (answer === 'unread' || answer === 'limited') {
      if (answer === 'limited') budget.reads = budget.limit;
      seen.stopped = true;
      seen.streak ??= eventId;
      return seen;
    }
    budget.reads += 1;
    budget.quiet = answer === 'unknown' ? budget.quiet + 1 : 0;
    if (answer === 'absent') return { ...seen, read: 'absent' };
    if (answer === 'unknown') {
      seen.read = 'unknown';
      seen.first ??= eventId;
      seen.streak ??= eventId;
    } else {
      seen.heard = true;
      seen.streak = undefined;
    }
  }
  return seen;
}

/**
 * Records one run's read. A run found absent keeps its turn, so the next pass
 * reads it first. A run read through is answered. A run with nothing
 * answered, stopped by the budget before any read or read after the pass's
 * other reads (the allowance may be spent), is left: it keeps its turn and
 * place. Otherwise it is unanswered, and stops at the first unanswered span
 * after its last answer, or, stopped by the budget, at the span after that
 * answer; with no answer, at the span after the one its read began at. So a
 * read moves on, and while these are the pass's only reads, past no span the
 * store would have answered.
 */
function settle(
  reading: Reading,
  runId: string,
  seen: Seen,
  late: boolean,
  order: readonly (string | undefined)[],
): void {
  if (seen.read === 'absent') return;
  if (!seen.stopped && seen.read !== 'unknown') reading.answered.push(runId);
  else if (!seen.heard && (late || seen.read !== 'unknown')) reading.left.push(runId);
  else {
    reading.unanswered.push(runId);
    reading.resumes.push((seen.heard ? (seen.streak ?? seen.first) : order[1]) ?? order[0] ?? null);
  }
}

/** The run's sent owed events from where its last read stopped, round to it; the trace alone when none. */
function from(reading: Reading, runId: string): readonly (string | undefined)[] {
  const sent = reading.sent.get(runId);
  if (sent === undefined) return [undefined];
  const at = sent.indexOf(reading.resume.get(runId) ?? '');
  return at > 0 ? [...sent.slice(at), ...sent.slice(0, at)] : sent;
}

/**
 * The runs a pass's owed read-back read, answered or not, on a batch row that
 * confirms nothing; none when it left every run it read.
 */
export async function recordReading(
  tx: TenantQuery,
  reading: Reading,
  windowDays: number,
): Promise<void> {
  if (reading.unanswered.length + reading.answered.length === 0) return;
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

/** What one read-back found of its runs: read absent, read present, or no answer. */
export interface Results {
  readonly absent: readonly string[];
  readonly present: readonly string[];
  readonly unread: readonly string[];
}

/** The results of a read-back of `runs` that found `gone`. */
export function resultsOf(
  runs: readonly string[],
  gone: readonly string[],
  reading: Reading,
): Results {
  const answered = new Set(reading.answered);
  return {
    absent: gone,
    present: runs.filter((runId) => answered.has(runId)),
    unread: runs.filter((runId) => !answered.has(runId) && !gone.includes(runId)),
  };
}

/**
 * One read-back's results, on a batch row that confirms nothing, after the
 * business's cursor row lock: confirmation and every writer of results take
 * it first, so confirmation judges a run's history after the wait.
 */
export async function recordResults(tx: TenantQuery, turn: Turn, results: Results): Promise<void> {
  await tx.query('select 1 from public.trace_export_cursors where business_id = $1 for update', [
    tx.businessId,
  ]);
  const runs = results.absent.length + results.present.length + results.unread.length;
  if (runs === 0) return;
  await tx.query(
    `insert into public.trace_expiry_batches
       (business_id, id, window_days, runs, expired_run_ids, code, pass_id, pass_seq,
        absent_run_ids, present_run_ids, unread_run_ids, recorded_at)
     values ($1, $2, $3, $4, '{}', 'expiry_unconfirmed', $5, $6::bigint,
             $7::uuid[], $8::uuid[], $9::uuid[], clock_timestamp())`,
    [
      tx.businessId,
      randomUUID(),
      turn.windowDays,
      runs,
      turn.passId,
      turn.seq,
      results.absent,
      results.present,
      results.unread,
    ],
  );
}
