// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 (#2017): the review shepherd's records. A scheduled occurrence's worker, under its run's
// live lease, writes one client comment on a review's task, an inbox item for each of the
// review's own client's people and the send that is that comment's email cause, in one
// transaction (`review_shepherd_sends`, 20261019184700). The broker asks `shepherdSendFor`
// before every send (`core-runtime/src/review-shepherd-authority.ts`).

import { createHash, randomUUID } from 'node:crypto';
import { readableNow } from '../inbox/access.ts';
import { raiseInboxItem } from '../inbox/items.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { writeComment } from '../tasks/comments.ts';

/** The lease the worker holds on the occurrence's run, and the worker. */
export interface ShepherdLease {
  readonly leaseId: string;
  readonly fence: number;
  readonly workerActorId: string;
}

export type ShepherdHoldRefusal = 'LEASE_NOT_OWNED' | 'APPROVAL_NOT_STANDING';

/**
 * The occurrence's run held for this transaction: its lease (the caller's, on the run the
 * occurrence's dispatch started, its fence current, held by an active worker) share-locked
 * first, then the run judged as it stands (`shepherdRunStands`).
 */
export async function holdShepherdRun(
  tx: TenantQuery,
  occurrenceId: string,
  lease: ShepherdLease,
): Promise<ShepherdHoldRefusal | undefined> {
  const [held] = await tx.query<{ readonly id: string }>(
    `select l.id from public.leases l
       join public.occurrence_dispatches d
         on d.business_id = l.business_id and d.run_id = l.run_id and d.occurrence_id = $5
            and d.outcome = 'started'
       join public.actors w
         on w.business_id = l.business_id and w.id = l.holder_actor_id and w.kind = 'worker'
            and w.active
      where l.business_id = $1 and l.id = $2 and l.fence = $3 and l.holder_actor_id = $4
      for share of l, w`,
    [tx.businessId, lease.leaseId, lease.fence, lease.workerActorId, occurrenceId],
  );
  if (held === undefined) return 'LEASE_NOT_OWNED';
  return await shepherdRunStands(tx, occurrenceId, lease.leaseId);
}

/**
 * The occurrence's activation share-locked (an occurrence row never changes once written), then
 * the clock read in the same statement: the lease must be live at it, the activation enabled on
 * the occurrence's version and its standing approval unrevoked. Asked again just before the
 * walk-through writes, after every lock it waited on, where it waits on nothing more: this
 * transaction already holds the lease and the activation.
 */
export async function shepherdRunStands(
  tx: TenantQuery,
  occurrenceId: string,
  leaseId: string,
): Promise<ShepherdHoldRefusal | undefined> {
  const [standing] = await tx.query<{ readonly live: boolean; readonly standing: boolean }>(
    `with instant as materialized (select clock_timestamp() as at)
     select (l.state = 'live' and l.expires_at > instant.at) as live,
            (a.enabled and a.version_id = o.version_id and o.approval_id is not null
             and not exists (select 1 from public.standing_approval_revocations r
                              where r.business_id = o.business_id
                                and r.approval_id = o.approval_id)) as standing
       from public.activation_occurrences o
       join public.activations a on a.business_id = o.business_id and a.id = o.activation_id
       join public.leases l on l.business_id = o.business_id and l.id = $3,
            instant
      where o.business_id = $1 and o.id = $2
      for share of a`,
    [tx.businessId, occurrenceId, leaseId],
  );
  if (standing === undefined || !standing.live) return 'LEASE_NOT_OWNED';
  if (!standing.standing) return 'APPROVAL_NOT_STANDING';
  return undefined;
}

/** A review's task, client and latest revision, and how many of its requests are still open. */
export interface ShepherdPending {
  readonly taskId: string;
  readonly partyId: string | null;
  readonly revision: number;
  readonly open: number;
}

/** The review, share-locked, and its open change requests: proposed, or approved with no task. */
export async function readShepherdPending(
  tx: TenantQuery,
  reviewId: string,
): Promise<ShepherdPending | undefined> {
  const [review] = await tx.query<{
    readonly taskId: string;
    readonly partyId: string | null;
    readonly revision: number;
  }>(
    `select task_id as "taskId", party_id as "partyId", revision_count as revision
       from public.reviews where business_id = $1 and id = $2 for share`,
    [tx.businessId, reviewId],
  );
  if (review === undefined) return undefined;
  const [count] = await tx.query<{ readonly open: number }>(
    `select count(*)::int as open from public.review_change_requests
      where business_id = $1 and review_id = $2
        and (state = 'proposed' or (state = 'approved' and created_task_id is null))`,
    [tx.businessId, reviewId],
  );
  return { ...review, open: count?.open ?? 0 };
}

/**
 * The review's own client's people: each reads the task now (`readableNow`) through a live
 * `task:read` grant scoped to that client, is not the business's staff, and has a confirmed
 * address. Ids only, in id order.
 */
export async function shepherdRecipients(
  tx: TenantQuery,
  taskId: string,
  partyId: string,
): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly id: string }>(
    `select p.id from public.people p
       join public.records r on r.business_id = p.business_id and r.id = $2
      where p.business_id = $1 and r.uuid_7 = $3
        and exists (select 1 from public.grants g
                     where g.business_id = p.business_id and g.subject_kind = 'person'
                       and g.subject_id = p.id and g.scope_kind = 'party' and g.scope_id = $3
                       and g.collection = 'task' and g.action = 'read' and g.revoked_at is null
                       and (g.expires_at is null or g.expires_at > clock_timestamp()))
        and not exists (select 1 from public.memberships ms
                         where ms.business_id = p.business_id and ms.person_id = p.id
                           and ms.active and ms.role_key in ('owner', 'admin', 'member'))
        and exists (select 1 from public.person_identifiers pi
                     where pi.business_id = p.business_id and pi.person_id = p.id
                       and pi.kind = 'email' and pi.review_state = 'confirmed')
        and ${readableNow('p.id', 'now()')}
      order by p.id`,
    [tx.businessId, taskId, partyId],
  );
  return rows.map((row) => row.id);
}

/** The digest an approval binds: the comment's body, its task and client, and its recipients. */
export function shepherdDigest(send: {
  readonly body: string;
  readonly taskId: string;
  readonly partyId: string;
  readonly recipients: readonly string[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify([send.body, send.taskId, send.partyId, [...send.recipients].toSorted()]))
    .digest('hex');
}

export interface ShepherdSendWrite {
  readonly occurrenceId: string;
  readonly reviewId: string;
  readonly taskId: string;
  readonly partyId: string;
  readonly body: string;
  readonly recipients: readonly string[];
  readonly workerActorId: string;
}

export interface ShepherdSendRow {
  readonly id: string;
  readonly commentId: string;
  readonly digest: string;
  readonly replayed: boolean;
}

/** The send this occurrence already wrote for this review, if any. */
export async function existingShepherdSend(
  tx: TenantQuery,
  occurrenceId: string,
  reviewId: string,
): Promise<ShepherdSendRow | undefined> {
  const [row] = await tx.query<{
    readonly id: string;
    readonly commentId: string;
    readonly digest: string;
  }>(
    `select id, comment_id as "commentId", digest from public.review_shepherd_sends
      where business_id = $1 and occurrence_id = $2 and review_id = $3`,
    [tx.businessId, occurrenceId, reviewId],
  );
  return row === undefined ? undefined : { ...row, replayed: true };
}

/**
 * The client comment, one `client_comment` inbox item per recipient and the send naming them,
 * in the caller's transaction. Raising the items sends nothing: the broker asks the send first.
 */
export async function writeShepherdSend(
  tx: TenantQuery,
  write: ShepherdSendWrite,
): Promise<ShepherdSendRow> {
  const [type] = await tx.query<{ readonly id: string }>(
    `select id from public.record_types where business_id = $1 and key = 'task_comment'`,
    [tx.businessId],
  );
  if (type === undefined) throw new Error('writeShepherdSend: the task spine is not installed');
  const commentId = await writeComment(tx, type.id, {
    taskId: write.taskId,
    authorActorId: write.workerActorId,
    commentType: 'client',
    audience: 'client',
    body: write.body,
    source: 'shepherd',
  });
  const digest = shepherdDigest(write);
  const id = randomUUID();
  await tx.query(
    `insert into public.review_shepherd_sends
       (business_id, id, occurrence_id, review_id, task_id, party_id, comment_id,
        recipient_person_ids, digest, worker_actor_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9, $10)`,
    [
      tx.businessId,
      id,
      write.occurrenceId,
      write.reviewId,
      write.taskId,
      write.partyId,
      commentId,
      [...write.recipients],
      digest,
      write.workerActorId,
    ],
  );
  for (const person of write.recipients) {
    // oxlint-disable-next-line no-await-in-loop
    await raiseInboxItem(tx, {
      recipientPersonId: person,
      subjectRecordId: write.taskId,
      reason: 'client_comment',
      fact: { kind: 'record', id: commentId },
    });
  }
  return { id, commentId, digest, replayed: false };
}

/** What the broker reads of a shepherd send, locked `for share` so an approval waits on it. */
export interface ShepherdSendFacts {
  readonly id: string;
  readonly partyId: string;
  readonly digest: string;
  readonly approvedDigest: string | null;
  readonly recipients: readonly string[];
  readonly standing: boolean;
}

/**
 * The send whose comment is `commentId`, or undefined for any other comment. `standing` is the
 * occurrence's activation still enabled on its version with its approval unrevoked.
 */
export async function shepherdSendFor(
  tx: TenantQuery,
  commentId: string,
): Promise<ShepherdSendFacts | undefined> {
  const [row] = await tx.query<ShepherdSendFacts>(
    `select s.id, s.party_id as "partyId", s.digest, s.approved_digest as "approvedDigest",
            s.recipient_person_ids::text[] as recipients,
            (a.enabled and a.version_id = o.version_id and not exists (
               select 1 from public.standing_approval_revocations v
                where v.business_id = o.business_id and v.approval_id = o.approval_id)) as standing
       from public.review_shepherd_sends s
       join public.activation_occurrences o
         on o.business_id = s.business_id and o.id = s.occurrence_id
       join public.activations a on a.business_id = o.business_id and a.id = o.activation_id
      where s.business_id = $1 and s.comment_id::text = $2
      for share of s`,
    [tx.businessId, commentId],
  );
  return row;
}
