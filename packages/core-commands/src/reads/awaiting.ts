// SPDX-License-Identifier: AGPL-3.0-only
//
// Which of a board's tasks wait at a gate: the run awaiting approval, the one
// wait main's run lifecycle stores (MP-5-11's waiting reason, `needs_approval`),
// and the rows the Review mode draws and counts (MP-5-12, CS-5.12).
//
// A task waits at a gate when a gate on its live proposal version is pending
// and has not expired (judged at the statement's start, as `gate.pending` is,
// not the transaction's, #444); one decided, expired or superseded waits on
// nobody. The question is asked only of the tasks the board already serves, so
// it never names, counts or reads a gate on a task the caller cannot read.
// Whether the wait is the caller's to end is `awaitingTheReader`'s question,
// answered by `task.decide`'s own rules.

import { readableScope, subjectsOf } from '../../../core-records/src/index.ts';
import type { Session, Subject, TenantQuery } from '../../../core-records/src/index.ts';
import { assignedTo, escalatedDecider, lockedInstant } from '../../../core-runtime/src/index.ts';

/**
 * The served tasks with a gate waiting for a decision, each true when every
 * gate waiting on it was escalated (T3a), which only a business-wide decider
 * decides.
 */
export async function awaitingApproval(
  tx: TenantQuery,
  taskIds: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  if (taskIds.length === 0) return new Map();
  const rows = await tx.query<{ readonly task_id: string; readonly escalated: boolean }>(
    // Escalation read through the row, as `decide` reads it: a database
    // upgraded only as far as an earlier migration has no 0041 column.
    `select run.task_id, bool_and((to_jsonb(g) ->> 'escalated_at') is not null) as escalated
       from public.gates g
       join public.planned_runs run
         on run.business_id = g.business_id and run.id = g.run_id
       join public.proposal_versions ver
         on ver.business_id = g.business_id and ver.id = g.version_id
      where g.business_id = $1
        and g.state = 'pending' and g.expires_at > statement_timestamp()
        and ver.superseded_at is null
        and run.task_id = any($2::uuid[])
      group by run.task_id`,
    [tx.businessId, taskIds],
  );
  return new Map(rows.map((row) => [row.task_id, row.escalated]));
}

/** Who asks the board, as `task.decide` would see them deciding. */
export interface DecideReach {
  /** The tasks their decide grants reach; null for decide across the business. */
  readonly records: readonly string[] | null;
  readonly subjects: readonly Subject[];
  readonly personId: string;
  readonly actorId: string;
}

/** The session's decide reach, from the same effective chain `task.decide` checks. */
export async function decideReach(tx: TenantQuery, session: Session): Promise<DecideReach> {
  const subjects = subjectsOf(session);
  const decide = await readableScope(tx, subjects, 'task', 'decide');
  return {
    records: decide.business ? null : decide.records,
    subjects,
    personId: session.personId,
    actorId: session.actorId,
  };
}

/**
 * The waiting tasks whose gate this reader's `task.decide` would admit, asked
 * with decide's own checks rather than a copy of them: a decide grant on the
 * task, decide across the business for an escalated gate (`escalatedDecider`),
 * and four eyes, so never the task's own assignee (`assignedTo`). Asked only of
 * the few rows already waiting; no reach given is none.
 */
export async function awaitingTheReader(
  tx: TenantQuery,
  waiting: ReadonlyMap<string, boolean>,
  reach: DecideReach | null,
): Promise<ReadonlySet<string>> {
  if (reach === null) return new Set();
  const granted = [...waiting].filter(
    ([taskId]) => reach.records === null || reach.records.includes(taskId),
  );
  if (granted.length === 0) return new Set();
  const ask = {
    subjects: reach.subjects,
    collection: 'task',
    decision: 'approve',
    decidedByPersonId: reach.personId,
    decidedByActorId: reach.actorId,
  };
  const wider = granted.some(([, escalated]) => escalated)
    ? (await escalatedDecider(tx, ask, true, await lockedInstant(tx))).ok
    : false;
  const open = granted.filter(([, escalated]) => !escalated || wider).map(([taskId]) => taskId);
  // One transaction's statements, queued on its one connection in this order.
  const mine = await Promise.all(
    open.map(async (taskId) => await assignedTo(tx, taskId, reach.personId)),
  );
  return new Set(open.filter((_, index) => mine[index] !== true));
}
