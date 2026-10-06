// SPDX-License-Identifier: AGPL-3.0-only
//
// A task's subtasks, as its page lists them (MP-4-4, CS-4.25 to CS-4.27).
//
// A subtask is a full task with grants of its own, and a record-scoped grant
// on the parent is not one on its children. So the family is read in one
// query that keeps a child only when the reader's live grants reach it
// (`readTaskFamily`): a step the reader may not read never leaves the
// database, and neither does its title, its id or its place in the count. An agent reads under its one task, which reaches no other record, so
// it is sent no steps; a step it should work on is delegated to it as a task.
// Whether a step waits at a gate is asked only of the steps sent (MP-5-11's
// `awaitingApproval`), so a gate on a step the reader cannot read is never read.

import { readTaskFamily } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { StepView } from '../../../core-wire/src/index.ts';
import { awaitingApproval } from './awaiting.ts';
import type { RankPool } from './rank.ts';

export async function readTaskSteps(
  tx: TenantQuery,
  taskTypeId: string,
  parentId: string,
  pool: RankPool,
): Promise<readonly StepView[]> {
  if (pool.kind === 'task') return [];
  const sent = (await readTaskFamily(tx, taskTypeId, parentId, pool.subjects)).children;
  if (sent.length === 0) return [];
  const gated = await awaitingApproval(
    tx,
    sent.map((child) => child.id),
  );
  return sent.map((child) => ({
    id: child.id,
    key: child.key,
    title: child.title,
    state: child.state,
    done: child.state?.machineCategory === 'completed',
    archived: child.archived,
    awaitingApproval: gated.has(child.id),
    assignee: child.assignee,
    revision: child.revision,
  }));
}
