// SPDX-License-Identifier: AGPL-3.0-only
//
// The four-eyes rule, once, for every money decision that has one: T2e's
// top-up (`budget.ts`), T3c's write-off (`recovery/write-off.ts`) and AW-05's
// top-up at the budget stop (`budget-answer.ts`).
//
// - The band is the business's `four_eyes_threshold`, in the currency's major
//   units, read `for share` under the caller's locks, so a change in flight is
//   waited on and the decision is made against the committed value. Null is
//   the band switched off; a business with no row has the shipped 500.
// - Above the band one person is not enough. A first approval pairs only with
//   a different person who approved the same figure and whose grant is live
//   at the locked instant; the caller's own first approval never pairs.
// - A first approver's grants are held without waiting under the runtime's
//   locks: contention rolls back into the entry's one retry.
//
// Each caller keeps what is its own: where first approvals are stored, what
// figure they must match, and the words of its refusals.

import type { Subject, TenantQuery } from '../../core-records/src/index.ts';
import { AffectedSetChanged } from './rediscovery.ts';
import { holdCoveringGrants } from './recovery/classifier.ts';

/** A person who gave a first approval, as the grant model reads them. */
export interface FirstApprover {
  readonly personId: string;
  readonly subjects: readonly Subject[];
}

/** Whether these subjects hold the decision's grant at the locked instant. */
export type Holds = (subjects: readonly Subject[]) => Promise<boolean>;

/** The band, in major units, of a business with no stored row. */
export const SHIPPED_FOUR_EYES_BAND = 500;

/** The currency's minor digits: 2 for AUD, 0 for JPY. */
export function minorDigits(currency: string): number {
  return (
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** The band in the currency's minor units, read under the caller's locks; null is off. */
export async function fourEyesBandMinor(tx: TenantQuery, currency: string): Promise<bigint | null> {
  const [row] = await tx.query<{ readonly value: unknown }>(
    `select value from public.business_settings
      where business_id = $1 and key = 'four_eyes_threshold'
      for share`,
    [tx.businessId],
  );
  const band = row === undefined ? SHIPPED_FOUR_EYES_BAND : row.value;
  if (typeof band !== 'number') return null;
  return BigInt(Math.round(band * 10 ** minorDigits(currency)));
}

/**
 * The first approval this decision pairs with. `null`: the figure is within
 * the band, or the band is off, and one person decides. The approver: a
 * different person, live at the locked instant, completes it. `undefined`:
 * two people are needed and none can pair yet, so this is a first approval.
 * `'own'`: the caller gave the only first approval, and one person twice is
 * one approver.
 */
export async function pairFor<A extends FirstApprover>(
  amountMinor: bigint,
  band: bigint | null,
  personId: string,
  firsts: readonly A[],
  holds: Holds,
): Promise<A | null | undefined | 'own'> {
  if (band === null || amountMinor <= band) return null;
  const others = firsts.filter((first) => first.personId !== personId);
  const live = await Promise.all(
    others.map(async (one) => ((await holds(one.subjects)) ? one : undefined)),
  );
  const pair = live.find((one) => one !== undefined);
  if (pair === undefined && firsts.length > others.length) return 'own';
  return pair;
}

/** First approvers' grants, held without waiting on a grant row under runtime locks. */
export async function holdFirstApprovers(
  tx: TenantQuery,
  firsts: readonly FirstApprover[],
  collection: string,
  decision: string,
): Promise<void> {
  if (firsts.length === 0) return;
  try {
    await holdCoveringGrants(
      tx,
      firsts.flatMap((first) => first.subjects),
      collection,
      'nowait',
    );
  } catch (cause) {
    if ((cause as { readonly code?: unknown }).code !== '55P03') throw cause;
    throw new AffectedSetChanged(`${decision}: a first approver's grant is being changed; retry`);
  }
}
