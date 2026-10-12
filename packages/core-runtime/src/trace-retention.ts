// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13: trace retention. The product is the trace store's deletion authority
// (contract 7.3): no vendor mechanism deletes a trace on this profile, so a
// pass here does, per business, from the product's own records.
//
// 1. The turn starts (`beginTurn`): its number, its one window cutoff, and
//    the runs owed too long settled.
// 2. The due runs (`askDue`), a page at a time after the last run selected,
//    at most `EXPIRY_PAGE` a pass, each with an ask written at the export
//    cursor's place before anything is deleted (#475).
// 3. One delete per page by derived trace id, through the port (custody's
//    egress), before anything is read. A failed delete ends the asks with a
//    gap batch. A pass that fails after a delete loses nothing: its asks are owed.
// 4. The owed runs read back, then each deleted page, on the pass's read
//    budget. Only reads finding a run gone in two passes in a row confirm it
//    (`trace-store.ts`): one 404 may be a span the store has not ingested.
// 5. Batch rows, append only (0103): each read-back's results, and per page or
//    place the runs asked, those confirmed at their place, and any gap code.
//
// The store applies a delete whenever it likes, and a confirmation proves one
// delete landed, never that another is not queued. So an ask stays owed until
// a batch confirms its run at its place or later, and while the run has an
// event after that place inside the window (`trace-owed.ts`). A run confirmed
// gone has its events after its place sent again (`sendAgain`) in the
// transaction that confirms it, or, when it has such events, is held back
// with its ask still owed; the export sends a run with an owed ask whole
// (`trace-export.ts`), and the run is due again once that event is past the
// window. The raw event copy is not this pass's: the bucket's lifecycle rule
// is its whole deletion path (the pinned profile's `minio` command).

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../core-records/src/index.ts';
import { gapOf, type GapCode } from './trace-delivery.ts';
import { TRACE_WINDOW_DAYS, type TraceDatabase } from './trace-export.ts';
import {
  absentHistory,
  askDue,
  beginTurn,
  byPlace,
  owedAsks,
  type Ask,
  type Owed,
  type OwedFrom,
} from './trace-owed.ts';
import {
  freshReading,
  passBudget,
  readBack,
  recordReading,
  recordResults,
  resultsOf,
  spent,
  traceOf,
  unsettled,
  type ExpiryPorts,
  type PassBudget,
  type Results,
  type Turn,
} from './trace-store.ts';

/** The deletion endpoint's cap on ids per call, and on asks per pass. */
export const EXPIRY_PAGE = 1_000;

export type ExpiryCode = GapCode | 'expiry_unconfirmed' | 'unconfirmed_expired';

export interface RetentionBatch {
  readonly runs: number;
  readonly confirmed: number;
  readonly code: ExpiryCode | null;
}

/**
 * One business's turn of a pass: its due runs asked and deleted page after
 * page, then the owed asks read back, then each deleted page, every read
 * counted by the pass's `budget` (one of its own when none is given).
 */
export async function expireOnce(
  database: TraceDatabase,
  businessId: string,
  key: Buffer,
  ports: ExpiryPorts,
  options: {
    readonly windowDays?: number;
    readonly page?: number;
    readonly budget?: PassBudget;
  } = {},
): Promise<readonly RetentionBatch[]> {
  const page = Math.max(1, options.page ?? EXPIRY_PAGE);
  const budget = options.budget ?? passBudget();
  const windowDays = options.windowDays ?? TRACE_WINDOW_DAYS;
  const begun = await database.withBusiness(
    businessId,
    async (tx) => await beginTurn(tx, budget.id, windowDays),
  );
  if (begun === undefined) return [];
  const { turn } = begun;
  const deleted = await askAndDelete(database, businessId, key, ports, turn, page);
  const owed = await readOwed(database, businessId, key, ports, deleted.asked, turn, budget, page);
  const batches: RetentionBatch[] = [...begun.settled, ...deleted.gap, ...owed];
  for (const ask of deleted.pages) {
    const reading = freshReading(budget);
    // eslint-disable-next-line no-await-in-loop -- one page after another; the store is not hurried
    const gone = await readBack(key, businessId, ports, ask.runs, reading);
    const results = resultsOf(ask.runs, gone, reading);
    // eslint-disable-next-line no-await-in-loop -- one page after another
    batches.push(...(await confirmReads(database, businessId, turn, results, [ask], true)));
  }
  return batches;
}

/** The due runs asked and deleted, page after page: the pages deleted, every run asked, and a failed delete's batch. */
async function askAndDelete(
  database: TraceDatabase,
  businessId: string,
  key: Buffer,
  ports: ExpiryPorts,
  turn: Turn,
  page: number,
): Promise<{ readonly pages: Ask[]; readonly asked: Set<string>; readonly gap: RetentionBatch[] }> {
  const pages: Ask[] = [];
  const asked = new Set<string>();
  while (asked.size < EXPIRY_PAGE) {
    const after = pages.at(-1)?.runs.at(-1) ?? null;
    const limit = Math.min(page, EXPIRY_PAGE - asked.size);
    // eslint-disable-next-line no-await-in-loop -- one page after another
    const ask: Ask = await database.withBusiness(
      businessId,
      async (tx) => await askDue(tx, turn.cutoff, after, limit),
    );
    if (ask.runs.length === 0) break;
    for (const runId of ask.runs) asked.add(runId);
    const ids = ask.runs.map((runId) => traceOf(key, businessId, runId));
    // eslint-disable-next-line no-await-in-loop -- one page after another
    const code = gapOf(await ports.expire(ids));
    if (code !== null) {
      const none = { absent: [], present: [], unread: [] };
      // eslint-disable-next-line no-await-in-loop -- the asks end here
      const gap = await confirmReads(database, businessId, turn, none, [ask], true, code);
      return { pages, asked, gap: [...gap] };
    }
    pages.push(ask);
    if (ask.runs.length < page) break;
  }
  return { pages, asked, gap: [] };
}

/**
 * Every owed run not just asked, page after page in turn order, whatever its
 * place, while the budget lasts: a page that stays present does not hide the
 * next. The runs the store did not answer are recorded with where they stopped.
 */
async function readOwed(
  database: TraceDatabase,
  businessId: string,
  key: Buffer,
  ports: ExpiryPorts,
  asked: ReadonlySet<string>,
  turn: Turn,
  budget: PassBudget,
  page: number,
): Promise<readonly RetentionBatch[]> {
  const batches: RetentionBatch[] = [];
  const reading = freshReading(budget);
  let after: OwedFrom | null = null;
  while (!spent(budget)) {
    const from: OwedFrom | null = after;
    // eslint-disable-next-line no-await-in-loop -- one page after another
    const owed: readonly Owed[] = await database.withBusiness(
      businessId,
      async (tx) => await owedAsks(tx, turn.cutoff, from, page),
    );
    for (const row of owed) {
      if (row.sent !== null) reading.sent.set(row.runId, row.sent);
      if (row.resume !== null) reading.resume.set(row.runId, row.resume);
    }
    const due = owed.filter((row) => !asked.has(row.runId));
    const runs = due.map((row) => row.runId);
    // eslint-disable-next-line no-await-in-loop -- one page after another; the store is not hurried
    const gone = await readBack(key, businessId, ports, runs, reading);
    const results = resultsOf(runs, gone, reading);
    // eslint-disable-next-line no-await-in-loop -- one page after another
    batches.push(...(await confirmReads(database, businessId, turn, results, byPlace(due), false)));
    const end = owed.at(-1);
    if (owed.length < page || end === undefined) break;
    after = { turn: end.turn, answered: end.answered, runId: end.runId };
  }
  if (unsettled(reading)) {
    await database.withBusiness(
      businessId,
      async (tx) => await recordReading(tx, reading, turn.windowDays),
    );
  }
  return batches;
}

/**
 * One transaction under the cursor row lock: a read-back's `results`
 * recorded, the history read, and for each ask's place a batch confirming its
 * runs read gone in two passes in a row, their later events sent again. A
 * `whole` page has its batch whatever it confirms, with `code` when its
 * delete failed; an owed place only when it confirms a run.
 */
async function confirmReads(
  database: TraceDatabase,
  businessId: string,
  turn: Turn,
  results: Results,
  asks: readonly Ask[],
  whole: boolean,
  code: ExpiryCode | null = null,
): Promise<readonly RetentionBatch[]> {
  if (asks.length === 0) return [];
  return await database.withBusiness(businessId, async (tx) => {
    await recordResults(tx, turn, results);
    const twice = await absentHistory(tx, results.absent);
    const batches: RetentionBatch[] = [];
    for (const ask of asks) {
      const gone = ask.runs.filter((runId) => twice.has(runId));
      const runs = whole ? ask.runs : gone;
      if (runs.length === 0) continue;
      // eslint-disable-next-line no-await-in-loop -- one place after another, in one transaction
      const held = gone.length > 0 ? await sendAgain(tx, gone, ask.place) : new Set<string>();
      const kept = gone.filter((runId) => !held.has(runId));
      const settled = code ?? (kept.length < runs.length ? 'expiry_unconfirmed' : null);
      // eslint-disable-next-line no-await-in-loop -- one place after another, in one transaction
      await tx.query(
        `insert into public.trace_expiry_batches (business_id, id, window_days, runs, expired_run_ids,
           code, after_tx, after_id, pass_id, pass_seq, recorded_at)
         values ($1, $2, $3, $4, $5::uuid[], $6, $7::xid8, $8::uuid, $9, $10::bigint, clock_timestamp())`,
        [
          tx.businessId,
          randomUUID(),
          turn.windowDays,
          runs.length,
          kept,
          settled,
          ask.place.tx,
          ask.place.id,
          turn.passId,
          turn.seq,
        ],
      );
      batches.push({ runs: runs.length, confirmed: kept.length, code: settled });
    }
    return batches;
  });
}

/**
 * A gone run's events after its place were in the trace the delete took, or
 * will be sent after it. The cursor goes back to just before the earliest
 * such event, or stays if it is already behind that, and the update gives
 * the row a new version even when the place is the same, under the row lock
 * the export's `advance` takes: an export that read before this never
 * advances past them. An event that commits after this statement's snapshot
 * is read after it too, so it is sent after the delete and needs nothing.
 * Answers the runs it found, which the batch does not confirm: their asks
 * stay owed, and each is due again once its later event is past the window.
 */
async function sendAgain(
  tx: TenantQuery,
  runs: readonly string[],
  place: Ask['place'],
): Promise<ReadonlySet<string>> {
  const rows = await tx.query<{ readonly runId: string }>(
    `with fresh as (
       select ev.run_id, ev.tx, ev.id from public.run_events ev
        where ev.business_id = $1 and ev.run_id = any($2::uuid[])
          and (ev.tx, ev.id) > ($3::xid8, $4::uuid)
     ), back as (
       select p.tx, p.id from public.run_events p
        where p.business_id = $1
          and (p.tx, p.id) < (select f.tx, f.id from fresh f order by f.tx, f.id limit 1)
        order by p.tx desc, p.id desc limit 1
     ), stepped as (
       update public.trace_export_cursors c
          set (after_tx, after_id) = (
                select b.tx, b.id
                  from (values (c.after_tx, c.after_id),
                               ((select tx from back), (select id from back))) b(tx, id)
                 order by b.tx nulls first, b.id nulls first limit 1),
              updated_at = now()
        where c.business_id = $1 and exists (select 1 from fresh)
     )
     select distinct run_id as "runId" from fresh`,
    [tx.businessId, runs, place.tx, place.id],
  );
  return new Set(rows.map((row) => row.runId));
}
