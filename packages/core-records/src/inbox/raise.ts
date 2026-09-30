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
// managers for a quarantined hold (an incident). Nobody is told of their own assignment or
// mention. A decision goes to every holder, the proposer included, because
// authority and not authorship decides who owes it, and a decision a person is
// responsible for is never switched off. The task's assignee is the one holder
// who is not owed it: four eyes (T2g) refuses their decision, so an item
// would count a decision they cannot make.

import { grantHolders } from '../authority/grant-reach.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { withdrawEndedGates } from './clear.ts';
import { taskAccess } from './access.ts';
import { raiseInboxItem, type InboxReason } from './items.ts';

/** The task's assignee, read in the raising transaction; null when unassigned. */
async function assigneeOf(tx: TenantQuery, taskId: string): Promise<string | null> {
  const rows = await tx.query<{ readonly assignee: string | null }>(
    `select uuid_2 as assignee from public.records where business_id = $1 and id = $2`,
    [tx.businessId, taskId],
  );
  return rows[0]?.assignee ?? null;
}

/**
 * A new pending gate. The task's superseded or ended gates have their open
 * items withdrawn (`clear.ts`), then every person holding `task:decide` on the
 * task (the key and scope the decision itself checks), the assignee aside, is
 * raised one item on the new gate.
 */
export async function raiseDecision(
  tx: TenantQuery,
  gate: { readonly taskId: string; readonly gateId: string },
): Promise<void> {
  await withdrawEndedGates(tx, gate.taskId);
  const holders = await grantHolders(tx, {
    collection: 'task',
    action: 'decide',
    scope: { kind: 'record', id: gate.taskId },
  });
  const assignee = await assigneeOf(tx, gate.taskId);
  for (const person of holders.filter((holder) => holder !== assignee)) {
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
 * An escalated gate (T3a). Escalating decides nothing, and from then on only a
 * holder of `task:decide` across the business decides the gate, so an open
 * item on it held by anyone else is withdrawn (they can no longer act on it)
 * and every such holder, the recipient among them, is raised one if they had
 * none: one granted the role after the gate was raised is owed it too. The
 * task's assignee is not a decider of it (four eyes), so theirs is withdrawn
 * and none is raised. Only
 * items about the gate's own task move: one whose pointer names the gate but
 * whose subject is another task is not this gate's.
 */
export async function raiseEscalation(
  tx: TenantQuery,
  escalated: { readonly gateId: string; readonly recipientPersonId: string },
): Promise<void> {
  const gates = await tx.query<{ readonly taskId: string }>(
    `select l.task_id as "taskId"
       from public.gates g
       join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
      where g.business_id = $1 and g.id = $2`,
    [tx.businessId, escalated.gateId],
  );
  const taskId = gates[0]?.taskId;
  if (taskId === undefined) throw new Error('raiseEscalation: the escalated gate is not here');
  const assignee = await assigneeOf(tx, taskId);
  const deciders = (
    await grantHolders(tx, {
      collection: 'task',
      action: 'decide',
      scope: { kind: 'business', id: null },
    })
  ).filter((person) => person !== assignee);
  await tx.query(
    `update public.inbox_items set work_state = 'withdrawn', closed_at = now()
      where business_id = $1 and reason = 'decision' and fact_kind = 'gate' and fact_id = $2
        and subject_record_id = $3 and work_state = 'open'
        and recipient_person_id <> all($4::uuid[])`,
    [tx.businessId, escalated.gateId, taskId, deciders],
  );
  const owed = new Set([...deciders, escalated.recipientPersonId]);
  owed.delete(assignee ?? '');
  for (const person of owed) {
    // oxlint-disable-next-line no-await-in-loop
    await raiseInboxItem(tx, {
      recipientPersonId: person,
      subjectRecordId: taskId,
      reason: 'decision',
      fact: { kind: 'gate', id: escalated.gateId },
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
 * unless they assigned themselves, and their open decision items on the task
 * are withdrawn, since four eyes now refuses their decision.
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
  if (change.assignee === null) return;
  await tx.query(
    `update public.inbox_items set work_state = 'withdrawn', closed_at = now()
      where business_id = $1 and subject_record_id = $2 and reason = 'decision'
        and work_state = 'open' and recipient_person_id = $3`,
    [tx.businessId, change.taskId, change.assignee],
  );
  if (change.assignee === change.by) return;
  await raiseInboxItem(tx, {
    recipientPersonId: change.assignee,
    subjectRecordId: change.taskId,
    reason: 'assignment',
    fact: { kind: 'record', id: change.taskId },
  });
}

/**
 * An incident (CS-16.8): a hold a transition classified `quarantined`. Its
 * attempt carries a dispatch marker or an observation, so what the work did is
 * unknown and its full hold stays retained until a person reconciles it.
 * Cancel, revocation and handback each classify holds in their own
 * transaction and pass them all here; everyone holding `task:manage` on the
 * task is raised one item on the quarantined run.
 */
export async function raiseIncident(
  tx: TenantQuery,
  classified: readonly { readonly reservationId: string; readonly state: string }[],
): Promise<void> {
  const quarantined = classified.filter((hold) => hold.state === 'quarantined');
  if (quarantined.length === 0) return;
  const runs = await tx.query<{ readonly taskId: string; readonly runId: string }>(
    `select distinct p.task_id as "taskId", p.id as "runId"
       from public.reservations r
       join public.planned_runs p on p.business_id = r.business_id and p.id = r.run_id
      where r.business_id = $1 and r.id = any($2::uuid[])`,
    [tx.businessId, quarantined.map((hold) => hold.reservationId)],
  );
  for (const run of runs) {
    // oxlint-disable-next-line no-await-in-loop
    const holders = await grantHolders(tx, {
      collection: 'task',
      action: 'manage',
      scope: { kind: 'record', id: run.taskId },
    });
    for (const person of holders) {
      // oxlint-disable-next-line no-await-in-loop
      await raiseInboxItem(tx, {
        recipientPersonId: person,
        subjectRecordId: run.taskId,
        reason: 'incident',
        fact: { kind: 'planned_run', id: run.runId },
      });
    }
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
  /**
   * An outside party entitled to CS-16.8's client comment: a stored
   * entitlement on the client's party, never a login. This head stores none,
   * so `readMentions` answers false until the party model lands.
   */
  readonly paidClient: boolean;
}

/**
 * Who a comment names, and whether each can read it: the task, and for a
 * team-only comment a membership too, since an outside party never reads one.
 * A person of another business is not found here and is named back only by
 * the identifier the caller sent. An identifier matches in any letter case, as
 * the database compares it, and a found person comes back by their stored one.
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
  const asked = new Map(personIds.map((sent) => [sent.toLowerCase(), sent] as const));
  for (const [canonical, sent] of asked) {
    const person = people.find((row) => row.id.toLowerCase() === canonical);
    const readable =
      person !== undefined &&
      (person.member || comment.audience === 'client') &&
      // oxlint-disable-next-line no-await-in-loop
      (await taskAccess(tx, person.id, comment.taskId)) === 'readable';
    named.push({
      personId: person?.id ?? sent,
      label: person?.name ?? sent,
      readable,
      member: person?.member ?? false,
      paidClient: false,
    });
  }
  return named;
}

/**
 * A comment saved: each staff member it names is raised a mention, never the
 * comment's own author. CS-16.8's client comment is owed only to a paid
 * client (`Mentioned.paidClient`, a stored entitlement on the client's party,
 * not a login): an outside party named in a client-visible comment they can
 * read is raised one when they are a paid client, and nothing otherwise.
 */
export async function raiseMentions(
  tx: TenantQuery,
  comment: {
    readonly taskId: string;
    readonly commentId: string;
    readonly authorActorId: string;
    readonly audience: string;
  },
  named: readonly Mentioned[],
): Promise<void> {
  const authors = await tx.query<{ readonly person_id: string | null }>(
    'select person_id from public.actors where business_id = $1 and id = $2',
    [tx.businessId, comment.authorActorId],
  );
  const author = authors[0]?.person_id ?? null;
  for (const person of named) {
    const reason = mentionReason(person, comment.audience);
    if (person.personId === author || reason === undefined) continue;
    // oxlint-disable-next-line no-await-in-loop
    await raiseInboxItem(tx, {
      recipientPersonId: person.personId,
      subjectRecordId: comment.taskId,
      reason,
      fact: { kind: 'record', id: comment.commentId },
    });
  }
}

/** Staff are owed a mention; a paid client reading a client-visible comment, a client comment. */
function mentionReason(person: Mentioned, audience: string): InboxReason | undefined {
  if (person.member) return 'mention';
  if (person.paidClient && person.readable && audience === 'client') return 'client_comment';
  return undefined;
}
