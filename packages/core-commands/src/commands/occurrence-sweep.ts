// SPDX-License-Identifier: AGPL-3.0-only
//
// C33's scheduler and C52-A's dispatch in production (#1318): one pass over
// one business, which the API runs on an interval for each business it serves,
// as system work beside the conversation sweep. No route, command-line verb or
// agent operation reaches it.
//
// Each enabled scheduled activation is claimed at its latest due time, the
// last whole multiple of its `every_minutes` since the epoch at or before
// `now`, and an approved occurrence dispatched at once by the business's
// worker (`occurrenceRunStarter`), claim and dispatch in one transaction per
// activation, as `claimOccurrence` allows. Due times missed while no pass ran
// are not claimed late: the next pass claims the time due then. A repeated
// pass, a restart or a second API process claims the same due time again and
// is answered with the first occurrence, so no run starts twice. Then the
// business's waiting occurrences, the runs held at the ceiling and the events
// queued at intake, are dispatched oldest first until the ceiling holds again.
//
// One activation or occurrence that throws is that one's failure, reported by
// id, and the pass goes on to the next.

import type { BusinessId, Database } from '../../../core-records/src/index.ts';
import {
  claimOccurrence,
  dispatchOccurrence,
  waitingOccurrences,
  type Dispatch,
} from '../../../core-records/src/index.ts';
import { occurrenceRunStarter } from './automation-run.ts';

export interface OccurrenceSweepRequest {
  readonly businessId: BusinessId;
  /** The business's own active worker actor, which starts each run. */
  readonly workerActorId: string;
  /** The pass's clock: due times are judged against it. */
  readonly now: Date;
}

export interface OccurrenceSweepReport {
  /** Occurrences this pass wrote, whatever their outcome. */
  readonly claimed: readonly string[];
  /** Runs this pass started. */
  readonly started: readonly string[];
  /** Activations or occurrences, by id, whose transaction threw. */
  readonly failed: readonly string[];
}

/** The latest time an activation run every `everyMinutes` is due, at or before `now`. */
export function latestDue(everyMinutes: number, now: Date): Date {
  const period = everyMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / period) * period);
}

interface Tally {
  readonly claimed: string[];
  readonly started: string[];
  readonly failed: string[];
}

/** A dispatch's run, counted when it started one. */
function count(tally: Tally, sent: Dispatch): void {
  if (sent.kind === 'dispatched' && sent.dispatch.runId !== null)
    tally.started.push(sent.dispatch.runId);
}

/** Each enabled scheduled activation claimed at its latest due time, an approved one dispatched. */
async function fireScheduled(
  database: Database,
  { businessId, workerActorId, now }: OccurrenceSweepRequest,
  tally: Tally,
): Promise<void> {
  const due = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly id: string; readonly every_minutes: number }>(
        `select id, every_minutes from public.activations
          where business_id = $1 and mode = 'scheduled' and enabled order by id`,
        [tx.businessId],
      ),
  );
  for (const activation of due) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one activation, one transaction, in turn
      await database.withBusiness(businessId, async (tx) => {
        const claim = await claimOccurrence(tx, activation.id, {
          dueAt: latestDue(activation.every_minutes, now),
        });
        if (claim.kind !== 'claimed' && claim.kind !== 'replayed') return;
        if (claim.kind === 'claimed') tally.claimed.push(claim.occurrence.id);
        if (claim.occurrence.outcome !== 'approved') return;
        const start = occurrenceRunStarter(workerActorId);
        count(tally, await dispatchOccurrence(tx, claim.occurrence.id, start));
      });
    } catch {
      tally.failed.push(activation.id);
    }
  }
}

/** The business's waiting occurrences dispatched, oldest first, until the ceiling holds. */
async function dispatchWaiting(
  database: Database,
  { businessId, workerActorId }: OccurrenceSweepRequest,
  tally: Tally,
): Promise<void> {
  const waiting = await database.withBusiness(businessId, (tx) => waitingOccurrences(tx));
  for (const occurrence of waiting) {
    try {
      const start = occurrenceRunStarter(workerActorId);
      // oxlint-disable-next-line no-await-in-loop -- one occurrence, one transaction, in turn
      const sent = await database.withBusiness(businessId, (tx) =>
        dispatchOccurrence(tx, occurrence.id, start),
      );
      if (sent.kind === 'waiting') return;
      count(tally, sent);
    } catch {
      tally.failed.push(occurrence.id);
    }
  }
}

/** One pass over one business: its scheduled activations claimed and dispatched, then its waiting ones. */
export async function sweepOccurrences(
  database: Database,
  request: OccurrenceSweepRequest,
): Promise<OccurrenceSweepReport> {
  const tally: Tally = { claimed: [], started: [], failed: [] };
  await fireScheduled(database, request, tally);
  await dispatchWaiting(database, request, tally);
  return tally;
}
