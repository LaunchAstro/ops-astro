// SPDX-License-Identifier: AGPL-3.0-only
//
// C33's scheduler in production (#1318): the occurrence sweep
// (`sweepOccurrences`) every minute over every business the deployment
// serves, as system work beside the conversation sweep. Nothing on the wire
// reaches it.
//
// Each business's pass runs as that business's own active worker, the actor
// that starts each run, found as the mail worker finds it; a business with
// none is skipped until it has one. A round sweeps each business once, in
// turn, and a round still running when the next is due is skipped, not
// stacked; the first runs at start. A business whose pass throws, or reports
// a failure, is logged by cause alone, never an id or an error's text, and the
// round goes on. `stop` starts no business after it and resolves once a pass
// in flight has ended, so the pool outlives every pass.

import { sweepOccurrences } from '../../packages/core-commands/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';

/** A minute: the shortest schedule an activation takes (`every_minutes` at least 1). */
export const OCCURRENCE_SWEEP_EVERY_MS = 60_000;

export interface OccurrenceSweeperOptions {
  /** The businesses to sweep, read at the start of every round. */
  readonly businesses: () => Promise<readonly BusinessId[]>;
  readonly everyMs?: number;
  /** The pass's clock; the wall clock unless a case sets one. */
  readonly now?: () => Date;
}

/** The business's active worker actor, or undefined while it has none. */
async function workerOf(database: Database, businessId: BusinessId): Promise<string | undefined> {
  const [worker] = await database.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly id: string }>(
        `select id from public.actors
          where business_id = $1 and kind = 'worker' and active order by id limit 1`,
        [tx.businessId],
      ),
  );
  return worker?.id;
}

/** One round over `options.businesses()`; `stopping`, once aborted, starts no further business. */
export function occurrenceRound(
  database: Database,
  options: OccurrenceSweeperOptions,
  stopping?: AbortSignal,
): () => Promise<void> {
  const now = options.now ?? (() => new Date());
  return async () => {
    for (const businessId of await options.businesses()) {
      if (stopping?.aborted === true) return;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one business's pass before the next's
        const workerActorId = await workerOf(database, businessId);
        if (workerActorId === undefined) continue;
        // oxlint-disable-next-line no-await-in-loop -- one business's pass before the next's
        const report = await sweepOccurrences(database, { businessId, workerActorId, now: now() });
        if (report.failed.length > 0) {
          console.error(
            'occurrence sweep: an activation or occurrence did not fire in one business',
          );
        }
      } catch {
        console.error('occurrence sweep: the pass failed in one business');
      }
    }
  };
}

/** The sweep on an interval, its first round at once; `stop` waits for a pass in flight. */
export function startOccurrenceSweeper(
  database: Database,
  options: OccurrenceSweeperOptions,
): { readonly stop: () => Promise<void> } {
  const stopping = new AbortController();
  const round = occurrenceRound(database, options, stopping.signal);
  let running: Promise<void> | undefined;
  const once = (): void => {
    if (stopping.signal.aborted || running !== undefined) return;
    running = round()
      .catch(() => {
        console.error('occurrence sweep: the round could not read its businesses');
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(once, options.everyMs ?? OCCURRENCE_SWEEP_EVERY_MS);
  timer.unref();
  once();
  return {
    stop: async () => {
      stopping.abort();
      clearInterval(timer);
      await running;
    },
  };
}
