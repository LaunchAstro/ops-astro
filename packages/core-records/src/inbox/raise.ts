// SPDX-License-Identifier: AGPL-3.0-only
//
// Raising (INB-1b). The command that makes a transition raises its items in
// its own transaction, so an item exists exactly when its transition
// committed and a refused or rolled-back one leaves none. No worker, sweep or
// recovery pass calls into this module.
//
// Each recipient comes from a fact the transition already holds: decide
// grants on the task for a decision, the person who authorised the lease for
// a settled run, the new assignee, the people a comment names, the task's
// managers for an incident. Nobody is told of their own assignment or
// mention. A decision goes to every holder, the proposer included, because
// authority and not authorship decides who owes it, and a decision a person is
// responsible for is never switched off.

import { grantHolders } from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { raiseInboxItem, taskAccess } from './items.ts';

/**
 * A new pending gate. The superseded gates of its lineage have their open
 * items withdrawn, then every person holding `task:decide` on the task (the
 * key and scope the decision itself checks) is raised one item on the new gate.
 */
export async function raiseDecision(
  tx: TenantQuery,
  gate: { readonly taskId: string; readonly gateId: string },
): Promise<void> {
  await tx.query(
    `update public.inbox_items i set work_state = 'withdrawn', closed_at = now()
       from public.gates g, public.gates raised
      where raised.business_id = $1 and raised.id = $2
        and g.business_id = raised.business_id and g.lineage_id = raised.lineage_id
        and g.state = 'superseded'
        and i.business_id = g.business_id and i.fact_kind = 'gate' and i.fact_id = g.id
        and i.work_state = 'open'`,
    [tx.businessId, gate.gateId],
  );
  const holders = await grantHolders(tx, {
    collection: 'task',
    action: 'decide',
    scope: { kind: 'record', id: gate.taskId },
  });
  for (const person of holders) {
    // oxlint-disable-next-line no-await-in-loop
    await raiseInboxItem(tx, {
      recipientPersonId: person,
      subjectRecordId: gate.taskId,
      reason: 'decision',
      fact: { kind: 'gate', id: gate.gateId },
    });
  }
}

/**
 * A handed-back lease. The person who authorised it launched the run: a
 * completed run tells them it finished and owes nothing; a failed one is
 * waiting on their move (restart or cancel). Answers the lease's task.
 */
export async function raiseRunSettled(
  tx: TenantQuery,
  settled: { readonly leaseId: string; readonly outcome: 'completed' | 'failed' },
): Promise<string> {
  const rows = await tx.query<{ readonly taskId: string; runId: string; launcher: string }>(
    `select task_id as "taskId", run_id as "runId", authorised_by_person_id as launcher
       from public.leases where business_id = $1 and id = $2`,
    [tx.businessId, settled.leaseId],
  );
  const lease = rows[0];
  if (lease === undefined) throw new Error('raiseRunSettled: the settled lease is not here');
  await raiseInboxItem(tx, {
    recipientPersonId: lease.launcher,
    subjectRecordId: lease.taskId,
    reason: settled.outcome === 'completed' ? 'run_finished' : 'waiting_run',
    fact: { kind: 'planned_run', id: lease.runId },
  });
  return lease.taskId;
}

/**
 * An assignment written. Whoever held the open assignment item and is no
 * longer the assignee has it withdrawn; the new assignee is raised one,
 * unless they assigned themselves.
 */
export async function raiseAssignment(
  tx: TenantQuery,
  change: { readonly taskId: string; readonly assignee: string | null; readonly by: string },
): Promise<void> {
  await tx.query(
    `update public.inbox_items set work_state = 'withdrawn', closed_at = now()
      where business_id = $1 and subject_record_id = $2 and reason = 'assignment'
        and work_state = 'open' and recipient_person_id is distinct from $3::uuid`,
    [tx.businessId, change.taskId, change.assignee],
  );
  if (change.assignee === null || change.assignee === change.by) return;
  await raiseInboxItem(tx, {
    recipientPersonId: change.assignee,
    subjectRecordId: change.taskId,
    reason: 'assignment',
    fact: { kind: 'record', id: change.taskId },
  });
}

/**
 * An incident on a task (CS-16.8). The incident record is C55's; its creating
 * transition calls this in its own transaction. Everyone holding `task:manage`
 * on the task is raised one item pointing at the incident record.
 */
export async function raiseIncident(
  tx: TenantQuery,
  incident: { readonly taskId: string; readonly incidentId: string },
): Promise<void> {
  const holders = await grantHolders(tx, {
    collection: 'task',
    action: 'manage',
    scope: { kind: 'record', id: incident.taskId },
  });
  for (const person of holders) {
    // oxlint-disable-next-line no-await-in-loop
    await raiseInboxItem(tx, {
      recipientPersonId: person,
      subjectRecordId: incident.taskId,
      reason: 'incident',
      fact: { kind: 'record', id: incident.incidentId },
    });
  }
}

/** A person a comment names, as this business knows them. */
export interface Mentioned {
  readonly personId: string;
  /** Their name here, or the identifier as sent when no such person is here. */
  readonly label: string;
  readonly readable: boolean;
  /** Staff, as opposed to an outside party with no membership. */
  readonly member: boolean;
}

/**
 * Who a comment names, and whether each can read it: the task, and for a
 * team-only comment a membership too, since an outside party never reads one.
 * A person of another business is not found here and is named back only by
 * the identifier the caller sent.
 */
export async function readMentions(
  tx: TenantQuery,
  comment: { readonly taskId: string; readonly audience: string },
  personIds: readonly string[],
): Promise<readonly Mentioned[]> {
  const people = await tx.query<{ readonly id: string; name: string; member: boolean }>(
    `select p.id, p.display_name as name,
            exists (select 1 from public.memberships m
                     where m.business_id = p.business_id and m.person_id = p.id and m.active)
              as member
       from public.people p where p.business_id = $1 and p.id = any($2::uuid[])`,
    [tx.businessId, personIds],
  );
  const named: Mentioned[] = [];
  for (const personId of new Set(personIds)) {
    const person = people.find((row) => row.id === personId);
    const readable =
      person !== undefined &&
      (person.member || comment.audience === 'client') &&
      // oxlint-disable-next-line no-await-in-loop
      (await taskAccess(tx, personId, comment.taskId)) === 'readable';
    named.push({
      personId,
      label: person?.name ?? personId,
      readable,
      member: person?.member ?? false,
    });
  }
  return named;
}

/**
 * A comment saved: each staff member it names is raised a mention, never the
 * comment's own author. An outside party is raised a client comment only
 * when the comment is client-visible and the client is a paid client
 * (CS-16.8); otherwise the comment still names them and raises nothing.
 */
export async function raiseMentions(
  tx: TenantQuery,
  comment: {
    readonly taskId: string;
    readonly commentId: string;
    readonly audience: string;
    readonly authorActorId: string;
    readonly paidClient: boolean;
  },
  named: readonly Mentioned[],
): Promise<void> {
  const authors = await tx.query<{ readonly person_id: string | null }>(
    'select person_id from public.actors where business_id = $1 and id = $2',
    [tx.businessId, comment.authorActorId],
  );
  const author = authors[0]?.person_id ?? null;
  for (const person of named) {
    if (person.personId === author) continue;
    const toClient = comment.audience === 'client' && comment.paidClient;
    if (!person.member && !toClient) continue;
    // oxlint-disable-next-line no-await-in-loop
    await raiseInboxItem(tx, {
      recipientPersonId: person.personId,
      subjectRecordId: comment.taskId,
      reason: person.member ? 'mention' : 'client_comment',
      fact: { kind: 'record', id: comment.commentId },
    });
  }
}
