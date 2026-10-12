// SPDX-License-Identifier: AGPL-3.0-only
//
// Which of a board's tasks wait at a gate: the run awaiting approval, the one
// wait main's run lifecycle stores (MP-5-11's waiting reason, `needs_approval`),
// and the rows the Review mode draws and counts (MP-5-12, CS-5.12).
//
// A task waits at a gate when a gate on a live lineage's current version is
// pending and has not expired (judged at the statement's start, as `gate.pending` is,
// not the transaction's, #444); one decided, expired, superseded or left on a
// cancelled lineage waits on nobody. The question is asked only of the tasks the board already serves, so
// it never names, counts or reads a gate on a task the caller cannot read.
// Whether the wait is the caller's to end is `awaitingTheReader`'s question,
// answered by `task.decide`'s own rules.

import {
  assigneesIfReadable,
  readableScope,
  readableTaskIds,
  readableTaskParams,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Session, Subject, TenantQuery } from '../../../core-records/src/index.ts';
import { escalatedDecider, lockedInstant } from '../../../core-runtime/src/index.ts';

/**
 * The gates waiting on these tasks, each with whether it was escalated (T3a),
 * asked only of those `readers` may read now (`readableTaskIds`).
 */
async function openGates(
  tx: TenantQuery,
  taskIds: readonly string[],
  readers: readonly Subject[] | null,
): Promise<
  readonly { readonly task_id: string; readonly id: string; readonly escalated: boolean }[]
> {
  if (taskIds.length === 0) return [];
  return await tx.query(
    // Escalation read through the row, as `decide` reads it: a database
    // upgraded only as far as an earlier migration has no 0041 column.
    `select run.task_id, g.id, (to_jsonb(g) ->> 'escalated_at') is not null as escalated
       from public.gates g
       join public.planned_runs run
         on run.business_id = g.business_id and run.id = g.run_id
       join public.proposal_versions ver
         on ver.business_id = g.business_id and ver.id = g.version_id
       join public.proposal_lineages l
         on l.business_id = g.business_id and l.id = g.lineage_id
      where g.business_id = $1
        and g.state = 'pending' and g.expires_at > statement_timestamp()
        and l.state = 'live' and ver.superseded_at is null
        and run.task_id = any(${readableTaskIds('$2::uuid[]', 3)})`,
    [tx.businessId, taskIds, ...readableTaskParams(readers)],
  );
}

/** The served tasks `readers` may still read with a gate waiting for a decision; null for every one. */
export async function awaitingApproval(
  tx: TenantQuery,
  taskIds: readonly string[],
  readers: readonly Subject[] | null,
): Promise<ReadonlySet<string>> {
  return new Set((await openGates(tx, taskIds, readers)).map((gate) => gate.task_id));
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
 * The waiting tasks with a gate this reader's `task.decide` would admit, asked
 * gate by gate with decide's own checks rather than a copy of them: a decide
 * grant on the task, decide across the business for an escalated gate
 * (`escalatedDecider`), and four eyes for that gate (`assignedTo`'s rule, read
 * by `assigneesIfReadable`). One gate must pass them all, so a gate four eyes
 * refuses beside an escalated gate the reader may not decide leaves them none. Asked only of the few rows already
 * waiting; no reach given is none.
 */
export async function awaitingTheReader(
  tx: TenantQuery,
  waiting: ReadonlySet<string>,
  reach: DecideReach | null,
): Promise<ReadonlySet<string>> {
  if (reach === null) return new Set();
  const granted = [...waiting].filter(
    (taskId) => reach.records === null || reach.records.includes(taskId),
  );
  const gates = await openGates(tx, granted, reach.subjects);
  const ask = {
    subjects: reach.subjects,
    collection: 'task',
    decision: 'approve',
    decidedByPersonId: reach.personId,
    decidedByActorId: reach.actorId,
  };
  const wider = gates.some((gate) => gate.escalated)
    ? (await escalatedDecider(tx, ask, true, await lockedInstant(tx))).ok
    : false;
  const open = gates.filter((gate) => !gate.escalated || wider);
  // One transaction's statements, queued on its one connection in this order.
  // Four eyes is asked with the task's read reach in the same statement: a
  // task the reader can no longer read waits on nobody here, and nothing of
  // it is read.
  const assigned = await Promise.all(
    open.map(async (gate) => await assigneesIfReadable(tx, gate.task_id, gate.id, reach.subjects)),
  );
  const me = reach.personId.toLowerCase();
  return new Set(
    open.filter((_, index) => assigned[index]?.includes(me) === false).map((gate) => gate.task_id),
  );
}
