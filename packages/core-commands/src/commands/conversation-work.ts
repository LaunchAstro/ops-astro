// SPDX-License-Identifier: AGPL-3.0-only
//
// A conversation's work (AW-03), read from records: the task it was opened
// on, the tasks it created, and the runs and gates it started, each with
// whether it has ended and when. The wrap-up lists what is left open and the
// purge holds the body while any of it is open, and for the window after the
// latest end.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { ConversationPointerView } from '../../../core-wire/src/index.ts';

/** The work the conversation cited or started, each with whether it has ended and when. */
export interface Work {
  readonly pointer: ConversationPointerView;
  readonly terminal: boolean;
  readonly endedAt: Date | null;
}

interface TaskRow {
  readonly id: string;
  readonly status_id: string | null;
  readonly completed_at: Date | null;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
}

/**
 * The tasks the conversation was opened on or created, each with its state; a
 * completed task ended at its stamp, and a task trashed before it ended, at
 * its trash.
 *
 * The purge reads them locked (`for share`): a reopen or a trash in flight
 * commits first and the purge reads the task as it left it, or waits for the
 * purge. Each status is read after the lock, so it is the committed one.
 */
async function taskWork(
  tx: TenantQuery,
  taskIds: readonly string[],
  lock: boolean,
): Promise<readonly Work[]> {
  if (taskIds.length === 0) return [];
  const tasks = await tx.query<TaskRow>(
    `select r.id, r.uuid_1 as status_id, r.ts_2 as completed_at, r.updated_at, r.deleted_at
       from records r
      where r.business_id = $1 and r.id = any($2::uuid[])
      order by r.id${lock ? ' for share' : ''}`,
    [tx.businessId, taskIds],
  );
  if (tasks.length === 0) return [];
  const statuses = await tx.query<{ readonly id: string; readonly category: string | null }>(
    `select id, data ->> 'machine_category' as category from records
      where business_id = $1 and id = any($2::uuid[]) and deleted_at is null`,
    [tx.businessId, tasks.map((task) => task.status_id)],
  );
  const categoryOf = new Map(statuses.map((status) => [status.id, status.category]));
  // Locked in id order; listed opened-on first, then as created.
  const ordered = tasks.toSorted((a, b) => taskIds.indexOf(a.id) - taskIds.indexOf(b.id));
  return ordered.map((task): Work => {
    const category = (task.status_id === null ? null : categoryOf.get(task.status_id)) ?? null;
    const ended = category === 'completed' || category === 'cancelled';
    return {
      pointer: {
        kind: 'task',
        id: task.id,
        address: `/task/${task.id}`,
        state: category ?? 'unknown',
      },
      terminal: ended || task.deleted_at !== null,
      endedAt: ended ? (task.completed_at ?? task.updated_at) : task.deleted_at,
    };
  });
}

/**
 * The runs and gates the conversation started, each pointing at its task. A
 * run ends at its last hand-back with no claim after it, or when its lineage
 * ends; a cancelled run whose lineage is still live (a budget stop waiting on
 * a person) has not ended, so it holds the body. A gate ends at its decision.
 */
async function startedWork(tx: TenantQuery, conversationId: string): Promise<readonly Work[]> {
  const runs = await tx.query<{
    id: string;
    task_id: string;
    state: string;
    ended_at: Date | null;
  }>(
    `select run.id, run.task_id, run.state,
            case run.state
              when 'handed_back' then (
                select max(e.created_at) from run_events e
                 where e.business_id = run.business_id and e.run_id = run.id
                   and e.kind = 'handed_back'
                   and not exists (select 1 from run_events l
                                    where l.business_id = e.business_id and l.run_id = e.run_id
                                      and l.kind = 'claimed' and l.position > e.position))
              when 'cancelled' then lin.terminal_at
            end as ended_at
       from planned_runs run
       left join proposal_lineages lin
         on lin.business_id = run.business_id and lin.id = run.lineage_id
      where run.business_id = $1 and run.origin_conversation_id = $2 order by run.id`,
    [tx.businessId, conversationId],
  );
  const gates = await tx.query<{
    id: string;
    task_id: string;
    state: string;
    decided_at: Date | null;
  }>(
    `select g.id, l.task_id, g.state, g.decided_at from gates g
       join proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
      where g.business_id = $1 and g.origin_conversation_id = $2 order by g.id`,
    [tx.businessId, conversationId],
  );
  return [
    ...runs.map((run): Work => ({
      pointer: { kind: 'run', id: run.id, address: `/task/${run.task_id}`, state: run.state },
      terminal: run.ended_at !== null,
      endedAt: run.ended_at,
    })),
    ...gates.map((gate): Work => ({
      pointer: { kind: 'gate', id: gate.id, address: `/task/${gate.task_id}`, state: gate.state },
      terminal: gate.state !== 'pending',
      endedAt: gate.decided_at,
    })),
  ];
}

/** The tasks whose creation audit event names the conversation as its origin. */
export async function createdTasks(
  tx: TenantQuery,
  conversationId: string,
): Promise<readonly ConversationPointerView[]> {
  const rows = await tx.query<{ readonly id: string }>(
    `select subject_record_id as id from audit_events
      where business_id = $1 and origin_conversation_id = $2
        and command = 'task.create' and outcome = 'applied'
      order by seq`,
    [tx.businessId, conversationId],
  );
  return rows.map((row) => ({ kind: 'task', id: row.id, address: `/task/${row.id}` }));
}

/**
 * The conversation's work: the task it was opened on, the tasks it created,
 * and the runs and gates it started. `lockTask` for the purge, which acts on
 * it.
 */
export async function workOf(
  tx: TenantQuery,
  conversationId: string,
  scopeRecordId: string | null,
  lockTask = false,
): Promise<readonly Work[]> {
  const created = (await createdTasks(tx, conversationId))
    .map((pointer) => pointer.id)
    .filter((id) => id !== scopeRecordId);
  const taskIds = scopeRecordId === null ? created : [scopeRecordId, ...created];
  return [...(await taskWork(tx, taskIds, lockTask)), ...(await startedWork(tx, conversationId))];
}
