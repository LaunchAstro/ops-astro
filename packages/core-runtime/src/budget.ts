// SPDX-License-Identifier: AGPL-3.0-only
//
// The budget arithmetic `decide` asks twice: once read-only before the first
// write (preflight), and again inside `reserve` as the second barrier. The two
// used to be word-for-word copies of the cap SQL and the refusal texts, and
// they had drifted on one point: `reserve` let a missing cap through where
// preflight refused it. That difference is now the `missingCap` parameter, so a
// reader sees it at the call rather than finding it by diffing two functions.
//
// W05's two reasons stay distinct: `BUDGET_UNAVAILABLE` is "this envelope has
// no room", `BUDGET_EXHAUSTED` is "the cap behind it has none". A caller told
// the wrong one raises the wrong ceiling.

import type { TenantQuery } from '../../core-records/src/tenancy/database.ts';
import { refuse, type RuntimeResult } from './refusals.ts';

/** A cap's ceiling and everything its envelopes hold or spent, as exact SQL text. */
export interface CapCommitted {
  readonly limitMinor: string;
  readonly committed: string;
  readonly currency: string;
}

/** An envelope's own totals, as exact SQL text. */
export interface EnvelopeTotals {
  readonly maximumMinor: string;
  readonly heldMinor: string;
  readonly actualMinor: string;
}

/** The cap's limit and its committed total, or nothing when no such cap exists. */
export async function capCommitted(
  tx: TenantQuery,
  capId: string,
): Promise<CapCommitted | undefined> {
  const caps = await tx.query<{
    readonly limit_minor: string;
    readonly committed: string;
    readonly currency: string;
  }>(
    `select c.limit_minor::text as limit_minor,
            coalesce(sum(e.held_minor + e.actual_minor), 0)::text as committed, c.currency
       from public.budget_caps c
       left join public.task_envelopes e on e.business_id = c.business_id and e.cap_id = c.id
      where c.business_id = $1 and c.id = $2
      group by c.limit_minor, c.currency`,
    [tx.businessId, capId],
  );
  const cap = caps[0];
  return cap === undefined
    ? undefined
    : { limitMinor: cap.limit_minor, committed: cap.committed, currency: cap.currency };
}

/** Does `wanted` fit in what the envelope has left? `null` when it does. */
export function envelopeVerdict(
  envelope: EnvelopeTotals,
  wanted: bigint,
): RuntimeResult<never> | null {
  const committed = BigInt(envelope.heldMinor) + BigInt(envelope.actualMinor);
  if (committed + wanted > BigInt(envelope.maximumMinor)) {
    return refuse(
      'BUDGET_UNAVAILABLE',
      `this task's envelope holds ${committed} of ${envelope.maximumMinor}, which leaves no room for ${wanted}`,
      'Raise the envelope through its authorised boundary, or propose bounded work that fits.',
    );
  }
  return null;
}

/**
 * Does `wanted` fit under the cap? `null` when it does.
 *
 * `missingCap` is the drift made explicit: preflight (`'refuse'`) answers a
 * missing cap with `BUDGET_UNAVAILABLE`, while `reserve` (`'pass'`) lets it
 * through, as it always has. `currency` is the version's currency when the
 * caller binds it here, as preflight does (Sol 6 RUNTIME-1), and `null` when
 * the caller does not, as `reserve` does not: `openEnvelope` has already bound
 * it at the write.
 */
export function capVerdict(of: {
  readonly cap: CapCommitted | undefined;
  readonly capId: string;
  readonly wanted: bigint;
  readonly currency: string | null;
  readonly missingCap: 'pass' | 'refuse';
}): RuntimeResult<never> | null {
  const { cap } = of;
  if (cap === undefined) {
    return of.missingCap === 'pass'
      ? null
      : refuse(
          'BUDGET_UNAVAILABLE',
          `no budget cap ${of.capId} in this business`,
          'Provision the cap before approving work that draws on it.',
        );
  }
  // Sol 6 RUNTIME-1: the cap is a ceiling in one currency, and a version in
  // another is refused here, before the first write, with the code an
  // existing envelope in another currency already answers.
  if (of.currency !== null && cap.currency !== of.currency) {
    return refuse(
      'CAP_BINDING_MISMATCH',
      `the cap behind this task is in ${cap.currency} and the version is in ${of.currency}`,
      'Propose the work in the currency the cap holds.',
    );
  }
  if (exceeds(cap.committed, of.wanted, cap.limitMinor)) {
    return refuse(
      'BUDGET_EXHAUSTED',
      `the cap behind this envelope has ${cap.committed} of ${cap.limitMinor} committed, so ${of.wanted} does not fit`,
      'The cap is the ceiling. Raising it is a separate authorised decision.',
    );
  }
  return null;
}

/**
 * Sol 6 RUNTIME-2: would `adding` take `committed` past `limit`? All three are
 * exact minor units. The two totals arrive as SQL text and are compared as
 * `bigint`, because a valid cap above 2^53 rounds as a JavaScript number and
 * the rounding can let one approval past the ceiling.
 */
function exceeds(committed: string, adding: bigint, limit: string): boolean {
  return BigInt(committed) + adding > BigInt(limit);
}
