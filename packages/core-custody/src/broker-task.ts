// SPDX-License-Identifier: AGPL-3.0-only
//
// The run's task, first in a model call's lock order: its client link (C60)
// and what a bound field reads of it as a source (S3).

import { slotOf, TASK_SPINE, type TenantQuery } from '../../core-records/src/index.ts';
import { LEAVES_ROW_DATA, type TaskSource } from './broker-sources.ts';

/** The spine's client slot: the party link `task.set_party` writes. */
const CLIENT_SLOT = slotOf(TASK_SPINE, 'client');

/** The lease's run's task. */
const TASK_OF_LEASE = `
       from public.leases l
       join public.planned_runs run on run.business_id = l.business_id and run.id = l.run_id
       join public.records t on t.business_id = run.business_id and t.id = run.task_id
      where l.business_id = $1 and l.id = $2`;

/** The run's task, taken `for share` before anything of it is read. */
const LOCK_TASK = `select t.id ${TASK_OF_LEASE} for share of t`;

/** An applied operation on the task by an actor, `o` joined to `a`. */
const APPLIED_ON_TASK = `select 1 from public.operations o
                join public.actors a on a.business_id = o.business_id and a.id = o.actor_id
               where o.business_id = t.business_id and o.record_id = t.id
                 and o.outcome = 'applied'`;

/**
 * Whether the operation's person held one of `roles` when it was applied: a
 * membership whose `[joined_at, ended_at)` covers `o.created_at`. A role
 * changes by ending one membership and starting another, so this is history,
 * never today's standing (owner line 72's provenance).
 */
const HELD_THEN = (roles: string): string => `exists (
                   select 1 from public.memberships m
                    where m.business_id = a.business_id and m.person_id = a.person_id
                      and m.role_key in ${roles}
                      and m.joined_at <= o.created_at
                      and (m.ended_at is null or m.ended_at > o.created_at))`;

/**
 * What S3 and owner line 72 read of the task `t`: its client, its data, and
 * who wrote it. Others wrote: an applied write by anyone but a person. Client
 * typed: an applied write by a person who held no staff role when they made it.
 * Owner started: its creation was applied by a person then holding the owner
 * role. `$3` is the commands that leave its data alone.
 */
const TASK_SOURCE = `t.id::text as id, t.${CLIENT_SLOT}::text as client,
            t.deleted_at is null as live, t.data,
            exists (${APPLIED_ON_TASK} and a.kind <> 'person'
                 and o.command <> all($3::text[])) as others_wrote,
            exists (${APPLIED_ON_TASK} and a.kind = 'person'
                 and o.command <> all($3::text[])
                 and not ${HELD_THEN(`('owner', 'admin', 'member')`)}) as client_typed,
            exists (${APPLIED_ON_TASK} and a.kind = 'person' and o.command = 'task.create'
                 and ${HELD_THEN(`('owner')`)}) as owner_started`;

/**
 * What S3 reads of the task, in a statement of its own after the lock: a
 * statement that waits on the lock rereads the task's row but keeps its
 * earlier view of the operations, so an edit committed during the wait would
 * be read without the write that made it.
 */
/** Whether `person` held the owner role at `at`: membership history, as `HELD_THEN` reads it. */
const OWNER_AT = (person: string, at: string): string => `exists (
                   select 1 from public.memberships m
                    where m.business_id = run.business_id and m.person_id = ${person}
                      and m.role_key = 'owner' and m.joined_at <= ${at}
                      and (m.ended_at is null or m.ended_at > ${at}))`;

/**
 * Whether the owner started the run (#1620 P4): its version proposed by a
 * person then holding the owner role, and every approval of it given by one.
 * A run an agent or a schedule proposed, or a member approved, is not.
 */
const OWNER_RAN = `exists (select 1 from public.proposal_versions v
                join public.actors pa on pa.business_id = v.business_id
                                     and pa.id = v.proposed_by_actor_id
               where v.business_id = run.business_id and v.id = run.version_id
                 and pa.kind = 'person' and ${OWNER_AT('pa.person_id', 'v.created_at')})
         and exists (select 1 from public.gate_decisions d
               where d.business_id = run.business_id and d.version_id = run.version_id
                 and d.decision = 'approve')
         and not exists (select 1 from public.gate_decisions d
               where d.business_id = run.business_id and d.version_id = run.version_id
                 and d.decision = 'approve'
                 and not ${OWNER_AT('d.decided_by_person_id', 'd.decided_at')})`;

/** The person who proposed the run's version: its starter (#1703), or null for an agent or a schedule. */
const STARTER = `(select pa.person_id::text from public.proposal_versions v
                join public.actors pa on pa.business_id = v.business_id
                                     and pa.id = v.proposed_by_actor_id
               where v.business_id = run.business_id and v.id = run.version_id
                 and pa.kind = 'person')`;

const READ_TASK = `select run.id::text as run_id, ${OWNER_RAN} as owner_ran, ${STARTER} as starter,
            ${TASK_SOURCE} ${TASK_OF_LEASE}`;

/** A task by its id, as a conversation's page: `$2` the task. */
const READ_PAGE = `select ${TASK_SOURCE}
       from public.records t where t.business_id = $1 and t.id = $2`;

interface TaskRow {
  readonly id: string;
  readonly client: string | null;
  readonly live: boolean;
  readonly data: Record<string, unknown>;
  readonly others_wrote: boolean;
  readonly client_typed: boolean;
  readonly owner_started: boolean;
}

/** The task as a source: owner line 72's finding needs every one of its facts. */
function sourceOf(task: TaskRow): TaskSource {
  const entered = task.data['source'];
  return {
    id: task.id,
    live: task.live,
    entered: typeof entered === 'string' ? entered : null,
    othersWrote: task.others_wrote,
    clientTyped: task.client_typed,
    ownerWork: task.owner_started && task.client === null,
    data: task.data,
  };
}

/**
 * The run's task, first in the lock order (`task` comes before `lease`), held
 * `for share` so a `task.set_party` cannot move its client while the call is
 * decided, and answering the task's client link (C60) and what a bound
 * field reads of it (S3): a link or an edit in flight is waited on, never
 * missed. The lease names the run and the run its
 * task, read here before the lease's own lock; the run's task is fixed once
 * written (the application may update a run's state only, 0086), and the
 * lease's run is compared again under the lease's lock (`lockFacts`).
 * Unknown to this business answers nothing, refused as a made-up lease is.
 */
export async function lockTask(
  tx: TenantQuery,
  leaseId: string,
): Promise<
  | {
      readonly runId: string;
      readonly clientId: string | null;
      readonly source: TaskSource;
      /** The owner proposed and approved the run (`OWNER_RAN`). */
      readonly ownerRan: boolean;
      /** The person who proposed the run (`STARTER`). */
      readonly starter: string | null;
    }
  | undefined
> {
  await tx.query(LOCK_TASK, [tx.businessId, leaseId]);
  const [task] = await tx.query<
    TaskRow & { run_id: string; owner_ran: boolean; starter: string | null }
  >(READ_TASK, [
    tx.businessId,
    leaseId,
    LEAVES_ROW_DATA,
  ]);
  if (task === undefined) return undefined;
  return {
    runId: task.run_id,
    clientId: task.client,
    source: sourceOf(task),
    ownerRan: task.owner_ran,
    starter: task.starter,
  };
}

/** A conversation's page task, as a source, and its client link; undefined when there is none. */
export async function readPage(
  tx: TenantQuery,
  taskId: string,
): Promise<{ readonly clientId: string | null; readonly source: TaskSource } | undefined> {
  const [task] = await tx.query<TaskRow>(READ_PAGE, [tx.businessId, taskId, LEAVES_ROW_DATA]);
  return task === undefined ? undefined : { clientId: task.client, source: sourceOf(task) };
}
