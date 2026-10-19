// SPDX-License-Identifier: AGPL-3.0-only
//
// C57's change requests (#2016, migration 20261019160000): one per client pin, filed by a
// person and decided by a person, at the review's holder. Every write locks the review the
// caller's grant covers (`lockCoveredReview`), so a filing and a decision on one review run
// one after the other, and a grant that does not cover the holder meets the answer an absent
// request gets. A request records only its own state: approval makes no task (#2117).

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import type { Covering } from '../site/covering.ts';
import { lockCoveredReview } from './reviews.ts';

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
