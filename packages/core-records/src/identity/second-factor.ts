// SPDX-License-Identifier: AGPL-3.0-only
//
// The second factor a person has at the sign-in provider, as this business
// records it (C59, migration 0049).
//
// The provider holds the factor and its secret. These rows hold only that the
// person has one and where it stands. Whether the person has a *verified* one
// is mirrored onto `people.second_factor_verified` in the same statement set,
// because login resolution asks it on every call and reads it inside the one
// query it already makes (`login-resolution.ts`). The factor is the login's,
// not the business's, so a verification and a removal are also written
// installation-wide by subject (0064), where resolution in every business the
// login reaches finds them. Every function takes the serving transaction, so
// the record and the audit event of the act that caused it commit together.

import { createHash, randomUUID } from 'node:crypto';
import { advisoryLock, type TenantQuery } from '../tenancy/database.ts';

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
 * The person's live factor. With `lock`, the subject of the login the person
 * signs in with, the login and then the person's own row are locked for the
 * rest of the transaction first, so an enrolment, a verification and a
 * removal for the same person queue behind each other instead of
 * interleaving, and so do two businesses completing enrolments for the one
 * login: the second then reads the first's verified factor (0064).
 *
 * The login's lock is the advisory key `second-factor-subject:<digest>`,
 * taken first, before any row or chain lock. The person's lock is on the
 * person, not the factor row, because a first enrolment has no factor row to
 * lock: two tabs would both find none and both insert. It is `no key update`,
 * the strength the mirror's own update takes, because rows this transaction
 * has already written reference the person and hold a key-share lock on it,
 * which `for update` would wait on in the other transaction and deadlock.
 */
export async function liveFactor(
  tx: TenantQuery,
  personId: string,
  options: { readonly lock?: string } = {},
): Promise<SecondFactor | undefined> {
  if (options.lock !== undefined) {
    await lockLoginFactors(tx, options.lock);
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

/**
 * The sign-in login's installation-wide lock, the advisory key
 * `second-factor-subject:<digest>` on its provider subject, taken first in its
 * transaction. A factor's record step takes it, a factor reset and an access
 * ending's provider steps (C58) hold it across their live-elsewhere check, and
 * the mapping trigger takes it before any live mapping of a login is written
 * (20261006213000), with the same digest in SQL.
 */
export async function lockLoginFactors(tx: TenantQuery, subject: string): Promise<void> {
  const digest = createHash('sha256').update(subject).digest('hex');
  await advisoryLock(tx, `second-factor-subject:${digest}`);
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

/** A factor of the person's, and the subject of the login that holds it at the provider. */
interface FactorOfLogin {
  readonly personId: string;
  readonly factorId: string;
  readonly subject: string;
}

const DIGEST = (text: string) => `encode(sha256(convert_to(${text}, 'UTF8')), 'hex')`;

/**
 * The factor's new state, by subject, for every business (0064): `$1` the
 * subject, `changed` the factor rows the statement moved, which it answers.
 * A verification a step-up repeats is written once.
 */
const BY_SUBJECT = `
  written as (
    insert into ops.second_factor_subjects (subject_digest, factor_digest, state)
    select ${DIGEST('$1')}, ${DIGEST('c.provider_factor_id')}, c.status from changed c
     where not exists (
       select 1 from ops.second_factor_subjects s
        where s.subject_digest = ${DIGEST('$1')}
          and s.factor_digest = ${DIGEST('c.provider_factor_id')} and s.state = c.status))
  select 1 from changed`;

/** The first verification completes an enrolment. A verified factor stays verified. */
export async function recordFactorVerified(tx: TenantQuery, factor: FactorOfLogin): Promise<void> {
  const verified = await tx.query(
    `with changed as (
       update public.second_factors
          set status = 'verified', verified_at = coalesce(verified_at, now())
        where business_id = $2 and person_id = $3 and id = $4 and status <> 'removed'
       returning provider_factor_id, status),
     ${BY_SUBJECT}`,
    [factor.subject, tx.businessId, factor.personId, factor.factorId],
  );
  if (verified.length > 0) await mirror(tx, factor.personId);
}

/** Replacing or removing a factor ends its row; the row is kept. */
export async function recordFactorRemoved(tx: TenantQuery, factor: FactorOfLogin): Promise<void> {
  await tx.query(
    `with changed as (
       update public.second_factors
          set status = 'removed', removed_at = now()
        where business_id = $2 and person_id = $3 and id = $4 and status <> 'removed'
       returning provider_factor_id, status),
     ${BY_SUBJECT}`,
    [factor.subject, tx.businessId, factor.personId, factor.factorId],
  );
  await mirror(tx, factor.personId);
}

/**
 * Whether the login has a factor verified, and not removed, through any
 * business (0064). A removed factor is never verified again, so no order.
 */
export async function loginHasVerifiedFactor(tx: TenantQuery, subject: string): Promise<boolean> {
  const rows = await tx.query<{ readonly held: boolean }>(
    `select exists (
       select 1 from ops.second_factor_subjects v
        where v.subject_digest = ${DIGEST('$1')} and v.state = 'verified'
          and not exists (
            select 1 from ops.second_factor_subjects r
             where r.subject_digest = v.subject_digest and r.factor_digest = v.factor_digest
               and r.state = 'removed')
     ) as held`,
    [subject],
  );
  return rows[0]?.held === true;
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
