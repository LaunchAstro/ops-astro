// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X's records (#2014, the version half; migration 20261019170000): the one review
// decision, bound to its revision's exact digest, and Astra's review of a revision. Both are
// written by a caller holding the review's row lock (`lockCoveredReview`), the lock a new
// revision is numbered under, so the latest revision and Astra's latest word on it read
// here cannot move before the write commits. Neither record is ever changed.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';

/** The review's latest revision and its author: the person it was written by or for. */
export interface DecidableRevision {
  readonly id: string;
  readonly digest: string;
  readonly authorPersonId: string;
}

export interface DecisionView {
  readonly response: 'approve';
  readonly digest: string;
  readonly decidedByPersonId: string;
  readonly singleOperatorSelfApproval: boolean;
  readonly decidedAt: string;
}

/** The locked review's latest revision, or undefined for a review with none. */
export async function latestRevision(
  tx: TenantQuery,
  reviewId: string,
): Promise<DecidableRevision | undefined> {
  const [row] = await tx.query<{
    readonly id: string;
    readonly digest: string;
    readonly created_by_person_id: string;
  }>(
    `select id, digest, created_by_person_id from public.review_revisions
      where business_id = $1 and review_id = $2 order by number desc limit 1`,
    [tx.businessId, reviewId],
  );
  return row === undefined
    ? undefined
    : { id: row.id, digest: row.digest, authorPersonId: row.created_by_person_id };
}

/**
 * Whether Astra's latest review of this exact digest approves it: a later `changes_requested`
 * withdraws an earlier approval, and a review of another digest counts for nothing.
 */
export async function astraApproves(
  tx: TenantQuery,
  revision: Pick<DecidableRevision, 'id' | 'digest'>,
): Promise<boolean> {
  const [latest] = await tx.query<{ readonly verdict: string }>(
    `select verdict from public.review_astra_reviews
      where business_id = $1 and revision_id = $2 and digest = $3
      order by created_at desc, id desc
      limit 1`,
    [tx.businessId, revision.id, revision.digest],
  );
  return latest?.verdict === 'approve';
}

interface Writer {
  readonly actorId: string;
  readonly personId: string;
}

/** Record Astra's review of the locked review's latest revision, as a person; its id. */
export async function insertAstraReview(
  tx: TenantQuery,
  input: {
    readonly reviewId: string;
    readonly revision: DecidableRevision;
    readonly verdict: 'approve' | 'changes_requested';
    readonly review: string;
    readonly writer: Writer;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into public.review_astra_reviews
       (business_id, id, review_id, revision_id, digest, verdict, review,
        recorded_by_actor_id, recorded_by_person_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tx.businessId,
      id,
      input.reviewId,
      input.revision.id,
      input.revision.digest,
      input.verdict,
      input.review,
      input.writer.actorId,
      input.writer.personId,
    ],
  );
  return id;
}

/**
 * Approve the locked review's latest revision on its digest, with the single-operator mark
 * when the decider is its author; its id, or undefined when the revision is approved already.
 */
export async function insertApproval(
  tx: TenantQuery,
  input: {
    readonly reviewId: string;
    readonly revision: DecidableRevision;
    readonly writer: Writer;
    readonly selfApproval: boolean;
  },
): Promise<string | undefined> {
  const rows = await tx.query<{ readonly id: string }>(
    `insert into public.review_decisions
       (business_id, id, review_id, revision_id, digest, response, author_person_id,
        decided_by_actor_id, decided_by_person_id, single_operator_self_approval)
     values ($1, $2, $3, $4, $5, 'approve', $6, $7, $8, $9)
     on conflict (business_id, revision_id) where response = 'approve' do nothing
     returning id`,
    [
      tx.businessId,
      randomUUID(),
      input.reviewId,
      input.revision.id,
      input.revision.digest,
      input.revision.authorPersonId,
      input.writer.actorId,
      input.writer.personId,
      input.selfApproval,
    ],
  );
  return rows[0]?.id;
}

/** Each of the review's decided revisions' decision, by revision; the caller judged the review. */
export async function decisionsOf(
  tx: TenantQuery,
  reviewId: string,
): Promise<ReadonlyMap<string, DecisionView>> {
  const rows = await tx.query<{
    readonly revision_id: string;
    readonly response: 'approve';
    readonly digest: string;
    readonly decided_by_person_id: string;
    readonly single_operator_self_approval: boolean;
    readonly decided_at: string;
  }>(
    `select revision_id, response, digest, decided_by_person_id, single_operator_self_approval,
            created_at::text as decided_at
       from public.review_decisions
      where business_id = $1 and review_id = $2 and response = 'approve'`,
    [tx.businessId, reviewId],
  );
  return new Map(
    rows.map((row) => [
      row.revision_id,
      {
        response: row.response,
        digest: row.digest,
        decidedByPersonId: row.decided_by_person_id,
        singleOperatorSelfApproval: row.single_operator_self_approval,
        decidedAt: row.decided_at,
      },
    ]),
  );
}
