// SPDX-License-Identifier: AGPL-3.0-only
//
// The second factor a person has at the sign-in provider, as this business
// records it (C59, migration 0032).
//
// The provider holds the factor and its secret. These rows hold only that the
// person has one and where it stands, which is what login resolution reads to
// refuse a sign-in made without it. Every function takes the serving
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
 * The person's live factor, locked for the rest of the transaction when
 * `lock` is set, so an enrolment, a verification and a removal of the same
 * person's factor queue behind each other instead of interleaving.
 */
export async function liveFactor(
  tx: TenantQuery,
  personId: string,
  options: { readonly lock?: boolean } = {},
): Promise<SecondFactor | undefined> {
  const rows = await tx.query<FactorRow>(
    `select id, person_id, provider, provider_factor_id, status
       from public.second_factors
      where business_id = $1 and person_id = $2 and status <> 'removed'
      ${options.lock === true ? 'for update' : ''}`,
    [tx.businessId, personId],
  );
  const row = rows[0];
  return row === undefined ? undefined : shaped(row);
}

/**
 * Whether a sign-in without the second factor is no longer enough for this
 * person.
 *
 * **A database from before 0032 has no factor table, and the answer there is
 * no.** Nobody in it can have recorded a factor, so this is the true answer
 * and not a way round the check. It matters because login resolution asks on
 * every call below `aal2`, and the upgrade proofs seed a database built to an
 * earlier migration through the real command path (`tests/runtime/fixture.ts`),
 * which is this path. A production upgrade migrates before the API restarts.
 */
export async function hasVerifiedFactor(tx: TenantQuery, personId: string): Promise<boolean> {
  const table = await tx.query<{ readonly present: boolean }>(
    `select to_regclass('public.second_factors') is not null as present`,
  );
  if (table[0]?.present !== true) return false;
  return (await liveFactor(tx, personId))?.status === 'verified';
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
  await tx.query(
    `update public.second_factors
        set status = 'verified', verified_at = coalesce(verified_at, now())
      where business_id = $1 and person_id = $2 and id = $3 and status <> 'removed'`,
    [tx.businessId, factor.personId, factor.factorId],
  );
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
}
