// SPDX-License-Identifier: AGPL-3.0-only
//
// T3e2: one report per outage, not one alert per run.
//
// Every drop (T3e1, `drop.ts`) joins the open report for its cause in its
// business, or opens one: the report names the cause, its window from the
// first drop to the last, and each run it dropped with whether the work came
// back. A report no drop has joined for `OUTAGE_WINDOW_SECONDS` is closed by
// the next drop of that cause, which opens another. At most one report is open
// per business and cause (0039's unique index), so concurrent drops of one
// outage meet on the same row: the insert that loses the race becomes the
// update. Written in the drop's own transaction, under its locks, so a report
// never names a drop that rolled back. Nothing is sent: the team reads the
// reports on `task.queue` and the task page (C12-6).
//
// AW-04 adds one cause that is not a drop: a pinned read's audit copy the
// store could not keep (`raiseMissingCopy`). Its row is one per business and
// digest (0062), names the digest and lists no runs.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../../core-records/src/index.ts';

/** How long an outage stays open with no new drop of its cause. */
export const OUTAGE_WINDOW_SECONDS = 300;

export type DropCause = 'provider_unavailable' | 'connection_lost' | 'worker_lost';

/** Whose fault each cause is: read from the cause, never stored twice (T3e1). */
export const DROP_FAULT: Readonly<Record<DropCause, 'provider' | 'network' | 'ours'>> = {
  provider_unavailable: 'provider',
  connection_lost: 'network',
  worker_lost: 'ours',
};

/** A report's cause: a drop's, or an audit copy the store could not keep. */
export type OutageCause = DropCause | 'audit_copy_missing';

const OUTAGE_FAULT: Readonly<Record<OutageCause, 'provider' | 'network' | 'ours'>> = {
  ...DROP_FAULT,
  audit_copy_missing: 'ours',
};

/** Join the open report for `cause`, or open one; the run is listed once. */
export async function joinOutage(
  tx: TenantQuery,
  drop: {
    readonly cause: DropCause;
    readonly attemptId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly reactivated: boolean;
  },
): Promise<string> {
  await tx.query(
    `update public.outage_reports set closed_at = last_drop_at
      where business_id = $1 and cause = $2 and closed_at is null
        and last_drop_at < now() - make_interval(secs => $3)`,
    [tx.businessId, drop.cause, OUTAGE_WINDOW_SECONDS],
  );
  const [report] = await tx.query<{ readonly id: string }>(
    `insert into public.outage_reports (business_id, id, cause) values ($1, $2, $3)
     on conflict (business_id, cause) where closed_at is null and content_digest is null
       do update set last_drop_at = greatest(public.outage_reports.last_drop_at, now())
     returning id`,
    [tx.businessId, randomUUID(), drop.cause],
  );
  const outageId = String(report?.id);
  await tx.query(
    `insert into public.outage_runs (business_id, outage_id, attempt_id, run_id, task_id, reactivated)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (business_id, attempt_id) do nothing`,
    [tx.businessId, outageId, drop.attemptId, drop.runId, drop.taskId, drop.reactivated],
  );
  return outageId;
}

/**
 * The dropped run came back: its step was reserved again, by a drop that
 * needed no proof or, for a marked step, once the pass proved the effect
 * absent or a person recorded that nothing happened.
 * A run no outage lists changes nothing.
 */
export async function markCameBack(tx: TenantQuery, attemptId: string): Promise<void> {
  await tx.query(
    `update public.outage_runs set reactivated = true
      where business_id = $1 and attempt_id = $2 and not reactivated`,
    [tx.businessId, attemptId],
  );
}

/**
 * AW-04: an audit copy the store could not keep, raised to the team as its
 * business's one row for the digest; a later miss of the digest joins it.
 */
export async function raiseMissingCopy(tx: TenantQuery, digest: string): Promise<void> {
  await tx.query(
    `insert into public.outage_reports (business_id, id, cause, content_digest)
     values ($1, $2, 'audit_copy_missing', $3)
     on conflict (business_id, content_digest) where content_digest is not null
       do update set last_drop_at = greatest(public.outage_reports.last_drop_at, now())`,
    [tx.businessId, randomUUID(), digest],
  );
}

export interface OutageReport {
  readonly id: string;
  readonly cause: OutageCause;
  /** Whose fault the cause names: the provider's, the network's, or ours. */
  readonly fault: 'provider' | 'network' | 'ours';
  readonly openedAt: string;
  readonly lastDropAt: string;
  /** Null while drops of its cause may still join it. */
  readonly closedAt: string | null;
  /** The file an `audit_copy_missing` row is about; null for a drop's report. */
  readonly contentDigest: string | null;
  readonly runs: readonly {
    readonly taskId: string;
    readonly runId: string;
    readonly attemptId: string;
    readonly reactivated: boolean;
  }[];
}

/** This business's outage reports, newest first, each with the runs it dropped (none for a copy's). */
export async function readOutages(tx: TenantQuery, limit = 20): Promise<readonly OutageReport[]> {
  const rows = await tx.query<{
    readonly id: string;
    readonly cause: OutageCause;
    readonly opened_at: string;
    readonly last_drop_at: string;
    readonly closed_at: string | null;
    readonly content_digest: string | null;
    readonly runs: OutageReport['runs'] | null;
  }>(
    `select r.id, r.cause, r.opened_at::text, r.last_drop_at::text, r.closed_at::text,
            r.content_digest,
            (select json_agg(json_build_object('taskId', o.task_id, 'runId', o.run_id,
                                               'attemptId', o.attempt_id,
                                               'reactivated', o.reactivated)
                             order by o.task_id, o.attempt_id)
               from public.outage_runs o
              where o.business_id = r.business_id and o.outage_id = r.id) as runs
       from public.outage_reports r
      where r.business_id = $1
      order by r.last_drop_at desc, r.id
      limit $2`,
    [tx.businessId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    cause: row.cause,
    fault: OUTAGE_FAULT[row.cause],
    openedAt: row.opened_at,
    lastDropAt: row.last_drop_at,
    closedAt: row.closed_at,
    contentDigest: row.content_digest,
    runs: row.runs ?? [],
  }));
}
