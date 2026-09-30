// SPDX-License-Identifier: AGPL-3.0-only
//
// The second factor a person has at the sign-in provider, as this business
// records it (C59, migration 0042).
//
// The provider holds the factor and its secret. These rows hold only that the
// person has one and where it stands. Whether the person has a *verified* one
// is mirrored onto `people.second_factor_verified` in the same statement set,
// because login resolution asks it on every call and reads it inside the one
// query it already makes (`login-resolution.ts`). Every function takes the serving
// transaction, so the record and the audit event of the act that caused it
// commit together.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';

export type FactorStatus = 'unverified' | 'verified' | 'removed';

export interface SecondFactor {
  readonly id: string;
  readonly personId: string;
  readonly provider: string;
  readonly providerFactorId: string;
  readonly status: FactorStatus;
}

interface FactorRow {
  readonly id: string;
  readonly person_id: string;
  readonly provider: string;
  readonly provider_factor_id: string;
  readonly status: FactorStatus;
}

const shaped = (row: FactorRow): SecondFactor => ({
  id: row.id,
  personId: row.person_id,
  provider: row.provider,
  providerFactorId: row.provider_factor_id,
  status: row.status,
});

/**
 * The person's live factor. With `lock`, the person's own row is locked for
 * the rest of the transaction first, so an enrolment, a verification and a
 * removal for the same person queue behind each other instead of
 * interleaving. The lock is on the person, not the factor row, because a
 * first enrolment has no factor row to lock: two tabs would both find none
 * and both insert. It is `no key update`, the strength the mirror's own
 * update takes, because rows this transaction has already written reference
 * the person and hold a key-share lock on it, which `for update` would wait
 * on in the other transaction and deadlock.
 */
export async function liveFactor(
  tx: TenantQuery,
  personId: string,
  options: { readonly lock?: boolean } = {},
): Promise<SecondFactor | undefined> {
  if (options.lock === true) {
    await tx.query(
      'select 1 from public.people where business_id = $1 and id = $2 for no key update',
      [tx.businessId, personId],
    );
  }
  const rows = await tx.query<FactorRow>(
    `select id, person_id, provider, provider_factor_id, status
       from public.second_factors
      where business_id = $1 and person_id = $2 and status <> 'removed'`,
    [tx.businessId, personId],
  );
  const row = rows[0];
  return row === undefined ? undefined : shaped(row);
}

/** A first enrolment: the provider has issued a factor that is not yet verified. */
export async function recordFactorEnrolled(
  tx: TenantQuery,
  factor: {
    readonly personId: string;
    readonly provider: string;
    readonly providerFactorId: string;
  },
): Promise<SecondFactor> {
  const rows = await tx.query<FactorRow>(
    `insert into public.second_factors (business_id, id, person_id, provider, provider_factor_id)
     values ($1, $2, $3, $4, $5)
     returning id, person_id, provider, provider_factor_id, status`,
    [tx.businessId, randomUUID(), factor.personId, factor.provider, factor.providerFactorId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('recordFactorEnrolled: the insert returned no row');
  return shaped(row);
}

/** The first verification completes an enrolment. A verified factor stays verified. */
export async function recordFactorVerified(
  tx: TenantQuery,
  factor: { readonly personId: string; readonly factorId: string },
): Promise<void> {
  const verified = await tx.query(
    `update public.second_factors
        set status = 'verified', verified_at = coalesce(verified_at, now())
      where business_id = $1 and person_id = $2 and id = $3 and status <> 'removed'
      returning id`,
    [tx.businessId, factor.personId, factor.factorId],
  );
  if (verified.length > 0) await mirror(tx, factor.personId);
}

/** Replacing or removing a factor ends its row; the row is kept. */
export async function recordFactorRemoved(
  tx: TenantQuery,
  factor: { readonly personId: string; readonly factorId: string },
): Promise<void> {
  await tx.query(
    `update public.second_factors
        set status = 'removed', removed_at = now()
      where business_id = $1 and person_id = $2 and id = $3 and status <> 'removed'`,
    [tx.businessId, factor.personId, factor.factorId],
  );
  await mirror(tx, factor.personId);
}

/** The person row's copy of "has a verified factor", recomputed from the factor rows. */
async function mirror(tx: TenantQuery, personId: string): Promise<void> {
  await tx.query(
    `update public.people p
        set second_factor_verified = exists (
              select 1 from public.second_factors f
               where f.business_id = p.business_id and f.person_id = p.id
                 and f.status = 'verified')
      where p.business_id = $1 and p.id = $2`,
    [tx.businessId, personId],
  );
}
