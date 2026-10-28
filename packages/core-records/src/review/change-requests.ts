// SPDX-License-Identifier: AGPL-3.0-only
//
// C57's change requests (#2016, migration 20261028160000): one per client pin, filed by a
// person and decided by a person, at the review's holder. Every write locks the review the
// caller's grant covers (`lockCoveredReview`), so a filing and a decision on one review run
// one after the other, and a grant that does not cover the holder meets the answer an absent
// request gets. Approval makes no task: an approved request with none is the pending cause a
// worker holds under its live lease on the review's task and makes a task of (#2117).

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import type { Covering } from '../site/covering.ts';
import { lockCoveredReview } from './reviews.ts';
import { holdTaskLease, type LeaseAt, type ObservedRefusal } from '../site/task-lease.ts';

export type ChangeRequestState = 'proposed' | 'approved' | 'refused';
export type ChangeRequestDecision = 'approve' | 'refuse';

/** The client pin a comment is: its review and that review's task. */
export interface PinSource {
  readonly commentId: string;
  readonly reviewId: string;
  readonly taskId: string;
}

export type ChangeRequestRefusal = {
  readonly code: 'NOT_FOUND' | 'CHANGE_REQUEST_ALREADY_FILED' | 'CHANGE_REQUEST_ALREADY_DECIDED';
};

export interface ChangeRequestWritten {
  readonly id: string;
  readonly state: ChangeRequestState;
  /** The review's holder, which the write's grant is read again at. */
  readonly partyId: string | null;
}

/** Who filed or decided: a person, never an agent. */
export interface ChangeRequestPerson {
  readonly actorId: string;
  readonly personId: string;
}

/**
 * The live client pin `commentId` names in this business, or undefined: an internal pin, a
 * comment that is no pin, a removed one and a foreign id are one answer. `lock` share-locks
 * the comment, so a removal waits for the filing that read it.
 */
export async function clientPinSource(
  tx: TenantQuery,
  commentId: string,
  lock = false,
): Promise<PinSource | undefined> {
  const [row] = await tx.query<{ readonly review_id: string; readonly task_id: string }>(
    `select c.id as review_id, c.task_id
       from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
       join public.review_revisions v
         on v.business_id = r.business_id and v.id::text = r.data->'anchor'->>'source'
       join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
      where r.business_id = $1 and r.id = $2 and t.key = 'task_comment'
        and r.deleted_at is null and r.data->>'audience' = 'client'
        and r.data->>'task' = c.task_id::text
      ${lock ? 'for share of r' : ''}`,
    [tx.businessId, commentId],
  );
  return row === undefined
    ? undefined
    : { commentId, reviewId: row.review_id, taskId: row.task_id };
}

/**
 * Files `text` as the one proposed change request of the client pin `source`, under the review
 * `covering` covers; the caller has locked the review's task first, as a pin does.
 */
export async function fileChangeRequest(
  tx: TenantQuery,
  source: PinSource,
  text: string,
  covering: Covering,
  by: ChangeRequestPerson,
): Promise<ChangeRequestWritten | ChangeRequestRefusal> {
  const review = await lockCoveredReview(tx, source.reviewId, covering);
  if (review === undefined) return { code: 'NOT_FOUND' };
  // Read again under the review's lock: the pin is still a live client pin on this review.
  const still = await clientPinSource(tx, source.commentId, true);
  if (still?.reviewId !== review.id) return { code: 'NOT_FOUND' };
  const [row] = await tx.query<{ readonly id: string }>(
    `insert into public.review_change_requests
       (business_id, id, review_id, comment_id, task_id, party_id, request_text,
        proposed_by_actor_id, proposed_by_person_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (business_id, comment_id) do nothing
     returning id`,
    [
      tx.businessId,
      randomUUID(),
      review.id,
      source.commentId,
      review.taskId,
      review.partyId,
      text,
      by.actorId,
      by.personId,
    ],
  );
  if (row === undefined) return { code: 'CHANGE_REQUEST_ALREADY_FILED' };
  return { id: row.id, state: 'proposed', partyId: review.partyId };
}

/**
 * Approves or refuses the proposed request `id`, under the review `covering` covers. A request
 * already decided keeps its decision.
 */
export async function decideChangeRequest(
  tx: TenantQuery,
  id: string,
  decision: ChangeRequestDecision,
  covering: Covering,
  by: ChangeRequestPerson,
): Promise<ChangeRequestWritten | ChangeRequestRefusal> {
  const [named] = await tx.query<{ readonly review_id: string }>(
    `select review_id from public.review_change_requests where business_id = $1 and id = $2`,
    [tx.businessId, id],
  );
  if (named === undefined) return { code: 'NOT_FOUND' };
  const review = await lockCoveredReview(tx, named.review_id, covering);
  if (review === undefined) return { code: 'NOT_FOUND' };
  const state: ChangeRequestState = decision === 'approve' ? 'approved' : 'refused';
  const [row] = await tx.query<{ readonly id: string }>(
    `update public.review_change_requests
        set state = $3, decided_by_actor_id = $4, decided_by_person_id = $5,
            decided_at = now(), updated_at = now()
      where business_id = $1 and id = $2 and state = 'proposed'
      returning id`,
    [tx.businessId, id, state, by.actorId, by.personId],
  );
  if (row === undefined) return { code: 'CHANGE_REQUEST_ALREADY_DECIDED' };
  return { id, state, partyId: review.partyId };
}

/** An approved request held for its task: still pending, or the task already made of it. */
export type HeldChange =
  | { readonly pending: true; readonly id: string; readonly taskId: string; readonly text: string }
  | { readonly pending: false; readonly id: string; readonly createdTaskId: string };

/**
 * The approved request `id` on the task the caller's live lease is on, locked and read again
 * after the lock wait, under the lease and the grants it stands on (`holdTaskLease`). A request
 * proposed, refused, on another task or absent is `NOT_FOUND`: only approval is a cause.
 */
export async function holdApprovedChange(
  tx: TenantQuery,
  at: LeaseAt,
  id: string,
): Promise<
  | { readonly ok: true; readonly subject: HeldChange }
  | { readonly ok: false; readonly code: ObservedRefusal }
> {
  return await holdTaskLease(tx, at, async (taskId): Promise<HeldChange | undefined> => {
    const [row] = await tx.query<{
      readonly task_id: string;
      readonly request_text: string;
      readonly created_task_id: string | null;
    }>(
      `select task_id, request_text, created_task_id from public.review_change_requests
        where business_id = $1 and id = $2 and task_id = $3 and state = 'approved'
        for update`,
      [tx.businessId, id, taskId],
    );
    if (row === undefined) return undefined;
    return row.created_task_id === null
      ? { pending: true, id, taskId: row.task_id, text: row.request_text }
      : { pending: false, id, createdTaskId: row.created_task_id };
  });
}

/** Links the task made of the held request `id`; the task and the link commit together. */
export async function linkChangeTask(tx: TenantQuery, id: string, taskId: string): Promise<void> {
  const linked = await tx.query(
    `update public.review_change_requests set created_task_id = $3, updated_at = now()
      where business_id = $1 and id = $2 and state = 'approved' and created_task_id is null
      returning id`,
    [tx.businessId, id, taskId],
  );
  if (linked.length !== 1) throw new Error('linkChangeTask: the held request was not pending');
}

export interface ChangeRequestView {
  readonly changeRequestId: string;
  readonly commentId: string;
  readonly state: ChangeRequestState;
  readonly text: string;
  /** The task made of an approved request; null while it is pending or for any other state. */
  readonly createdTaskId: string | null;
}

/** A review's change requests, oldest first, for a reader the review's read already admits. */
export async function readChangeRequests(
  tx: TenantQuery,
  reviewId: string,
): Promise<readonly ChangeRequestView[]> {
  const rows = await tx.query<{
    readonly id: string;
    readonly comment_id: string;
    readonly state: ChangeRequestState;
    readonly request_text: string;
    readonly created_task_id: string | null;
  }>(
    `select id, comment_id, state, request_text, created_task_id
       from public.review_change_requests
      where business_id = $1 and review_id = $2 order by created_at, id`,
    [tx.businessId, reviewId],
  );
  return rows.map((row) => ({
    changeRequestId: row.id,
    commentId: row.comment_id,
    state: row.state,
    text: row.request_text,
    createdTaskId: row.created_task_id,
  }));
}
