// SPDX-License-Identifier: AGPL-3.0-only
//
// R5's records (#1689): single-operator mode, the business's operators, and
// Astra's review of a correction. The mode's row is the lock a decision and a
// new operator meet on: the membership trigger (20261018050000) takes it for
// update whenever it makes an operator, and a self-approval share-locks it
// before it counts the operators, so a second operator is either waited for and
// counted, or added after the approval commits.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { FRESH } from './correction-decisions.ts';

export const SINGLE_OPERATOR_SETTING = 'single_operator_mode';

/** Whether the mode is on, its row locked `for share` (a decision) or `for update` (turning it on). */
export async function lockSingleOperatorMode(
  tx: TenantQuery,
  strength: 'share' | 'update',
): Promise<boolean> {
  const rows = await tx.query<{ readonly value: unknown }>(
    `select value from public.business_settings
      where business_id = $1 and key = $2
        for ${strength === 'share' ? 'share' : 'update'}`,
    [tx.businessId, SINGLE_OPERATOR_SETTING],
  );
  return rows[0]?.value === true;
}

/** The business's operators: people with an active membership in a staff role. */
export async function operatorCount(tx: TenantQuery): Promise<number> {
  const [row] = await tx.query<{ readonly n: string }>(
    `select count(distinct person_id)::text as n from public.memberships
      where business_id = $1 and active and ended_at is null
        and role_key in ('owner', 'admin', 'member')`,
    [tx.businessId],
  );
  return Number(row?.n ?? '0');
}

/** Whether the business has made a single-operator self-approval before. */
export async function hasSelfApproved(tx: TenantQuery): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.live_corrections
      where business_id = $1 and single_operator_self_approval limit 1`,
    [tx.businessId],
  );
  return rows.length > 0;
}

/**
 * Whether Astra's latest review of this exact version approves it: a later
 * `changes_requested` withdraws an earlier approval. Reviews of one correction
 * are written under its row lock, so the latest is the one written last.
 */
export async function reviewApproves(
  tx: TenantQuery,
  correctionId: string,
  versionDigest: string,
): Promise<boolean> {
  const [latest] = await tx.query<{ readonly verdict: string }>(
    `select verdict from public.live_correction_reviews
      where business_id = $1 and correction_id = $2 and version_digest = $3
      order by created_at desc, id desc
      limit 1`,
    [tx.businessId, correctionId, versionDigest],
  );
  return latest?.verdict === 'approve';
}

export interface NewReview {
  readonly correctionId: string;
  readonly versionDigest: string;
  readonly verdict: 'approve' | 'changes_requested';
  readonly review: string;
  readonly actorId: string;
  readonly personId: string;
}

/**
 * Record Astra's review of a correction the caller has locked and checked; its id. The review
 * lands only while the correction is `requested` at this version and the runner's last check of
 * its page is within the window, by the clock read in this statement, after every wait the review
 * took (#2063). Undefined: it does not, and nothing is written.
 */
export async function insertReview(
  tx: TenantQuery,
  review: NewReview,
): Promise<string | undefined> {
  const id = randomUUID();
  const rows = await tx.query<{ readonly id: string }>(
    `insert into public.live_correction_reviews
       (business_id, id, correction_id, version_digest, verdict, review,
        recorded_by_actor_id, recorded_by_person_id)
     select c.business_id, $2::uuid, c.id, c.version_digest, $5, $6, $7::uuid, $8::uuid
       from public.live_corrections c
      where c.business_id = $1 and c.id = $3 and c.state = 'requested'
        and c.version_digest = $4 and ${FRESH}
     returning id`,
    [
      tx.businessId,
      id,
      review.correctionId,
      review.versionDigest,
      review.verdict,
      review.review,
      review.actorId,
      review.personId,
    ],
  );
  return rows.length === 0 ? undefined : id;
}
