// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 (#2017): whether the broker may send one review shepherd item now. Asked inside the
// broker's checking transaction (`core-custody/src/broker-email.ts` `checkItem`), after the
// item and its task are locked, and again after the weekly window and the ceiling waited
// (`stillStanding`), every time it would send: a comment the shepherd did not write
// is not this module's to judge. A shepherd send stands only while the occurrence's activation
// is still enabled on its version with its standing approval unrevoked, the item's recipient is
// one the send named, and either a person approved the send's exact digest or a live standing
// mandate covers the shepherd's class for the review's client. A mandate refusal wins over a
// mandate, never over a person's approval of the exact send.

import { standingMandateVerdict } from '../mandates/verdict.ts';
import type { Covering } from '../site/covering.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { lockCoveredReview } from './reviews.ts';
import { shepherdSendFor } from './shepherd.ts';

/** The action class a standing mandate names to cover the shepherd's weekly email. */
export const SHEPHERD_ACTION_CLASS = 'review.shepherd.email';

/** An email moves no money: asked at zero, in the currency the installation's mandates use. */
const SHEPHERD_CURRENCY = 'AUD';

export type ShepherdSendVerdict = 'not-shepherd' | 'stands' | 'unapproved';

export async function shepherdSendStands(
  tx: TenantQuery,
  item: { readonly factKind: string; readonly factId: string; readonly recipient: string },
): Promise<ShepherdSendVerdict> {
  if (item.factKind !== 'record') return 'not-shepherd';
  const send = await shepherdSendFor(tx, item.factId);
  if (send === undefined) return 'not-shepherd';
  if (!send.standing || !send.recipients.includes(item.recipient)) return 'unapproved';
  if (send.approvedDigest !== null && send.approvedDigest === send.digest) return 'stands';
  const verdict = await standingMandateVerdict(tx, {
    clientId: send.partyId,
    actionClass: SHEPHERD_ACTION_CLASS,
    valueMinor: 0,
    currency: SHEPHERD_CURRENCY,
  });
  return verdict.covered ? 'stands' : 'unapproved';
}

/**
 * The items whose review shepherd send still stands, asked again after the weekly window and the
 * ceiling waited: a mandate that lapsed during those waits sends nothing. Other items pass.
 */
export async function stillStanding<
  T extends { readonly factKind: string; readonly factId: string; readonly recipient: string },
>(tx: TenantQuery, items: readonly T[]): Promise<T[]> {
  const kept: T[] = [];
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop
    if ((await shepherdSendStands(tx, item)) !== 'unapproved') kept.push(item);
  }
  return kept;
}

export interface ShepherdApprover {
  readonly actorId: string;
  readonly personId: string;
}

export type ShepherdApproval =
  | { readonly id: string; readonly digest: string }
  | { readonly code: 'NOT_FOUND' | 'SHEPHERD_DIGEST_STALE' | 'SHEPHERD_ALREADY_APPROVED' };

/**
 * A person approves one exact send: the digest they saw must be the send's own, and their
 * covering grant must reach its review (`lockCoveredReview`), else nothing is written.
 */
export async function approveShepherdSend(
  tx: TenantQuery,
  sendId: string,
  sawDigest: string,
  covering: Covering,
  by: ShepherdApprover,
): Promise<ShepherdApproval> {
  const [named] = await tx.query<{ readonly reviewId: string }>(
    `select review_id as "reviewId" from public.review_shepherd_sends
      where business_id = $1 and id = $2`,
    [tx.businessId, sendId],
  );
  if (named === undefined) return { code: 'NOT_FOUND' };
  if ((await lockCoveredReview(tx, named.reviewId, covering)) === undefined) {
    return { code: 'NOT_FOUND' };
  }
  const [row] = await tx.query<{ readonly id: string; readonly digest: string }>(
    `update public.review_shepherd_sends
        set approved_by_actor_id = $4, approved_by_person_id = $5, approved_digest = digest,
            approved_at = now()
      where business_id = $1 and id = $2 and digest = $3 and approved_digest is null
      returning id, digest`,
    [tx.businessId, sendId, sawDigest, by.actorId, by.personId],
  );
  if (row !== undefined) return row;
  const [current] = await tx.query<{ readonly approved: boolean; readonly digest: string }>(
    `select approved_digest is not null as approved, digest from public.review_shepherd_sends
      where business_id = $1 and id = $2`,
    [tx.businessId, sendId],
  );
  return current?.approved === true
    ? { code: 'SHEPHERD_ALREADY_APPROVED' }
    : { code: 'SHEPHERD_DIGEST_STALE' };
}
