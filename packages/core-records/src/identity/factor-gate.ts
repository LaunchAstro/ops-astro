// SPDX-License-Identifier: AGPL-3.0-only
//
// The second-factor gate login resolution asks after the person is known and
// active, and before anything is served (`login-resolution.ts`).
//
// - C59, LF-4: a sign-in that stopped at the password is not yet a sign-in
//   for a login that verified a second factor, in any business.
// - C39-T, the gate before the first real client data (item 2): a person an
//   accepted invitation of this business placed, with no verified factor,
//   sets one up before any content shows. Another business's invitation never
//   counts, and a person no invitation placed is served as before.
//
// Neither applies to the factor routes themselves (`enrolling`), which serve
// the sign-in that has not yet given its code or set its factor up.

import type { TenantQuery } from '../tenancy/database.ts';
import { loginHasVerifiedFactor } from './second-factor.ts';
import type { Assurance } from './verified-subject.ts';

/**
 * Whether a sign-in without the second factor is refused for a person who has
 * one. `required` everywhere but the factor routes themselves, which serve the
 * sign-in that has not yet given its code (C59: verifying is how it gets one).
 */
export type SecondFactorRule = 'required' | 'enrolling';

export type FactorGateCode = 'AUTH_SECOND_FACTOR_REQUIRED' | 'AUTH_SECOND_FACTOR_SETUP_REQUIRED';

export const FACTOR_GATE_FIXES: Readonly<Record<FactorGateCode, readonly string[]>> = {
  AUTH_SECOND_FACTOR_REQUIRED: ['enter the code from your authenticator app to finish signing in'],
  AUTH_SECOND_FACTOR_SETUP_REQUIRED: ['set up an authenticator app to finish signing in'],
};

/** The person as resolution found them: their id, and the factor their row mirrors. */
export interface GatedPerson {
  readonly personId: string;
  /** 'true' once the person has a verified second factor; null before 0049. */
  readonly mirrored: string | null;
  /** Whether the login's factors are kept by subject (0064), so every business reads them. */
  readonly bySubject: boolean;
  /** Whether the installation has invitations (C39-T); one stopped before them has none. */
  readonly invitations: boolean;
}

/** The gate's refusal for this sign-in, or nothing when it may be served. */
export async function factorGate(
  tx: TenantQuery,
  subject: string,
  person: GatedPerson,
  assurance: Assurance,
  rule: SecondFactorRule,
): Promise<FactorGateCode | undefined> {
  if (rule !== 'required') return undefined;
  const held = await factorHeld(tx, subject, person);
  if (held) return assurance.level === 'aal2' ? undefined : 'AUTH_SECOND_FACTOR_REQUIRED';
  if (!person.invitations) return undefined;
  return (await invited(tx, person.personId)) ? 'AUTH_SECOND_FACTOR_SETUP_REQUIRED' : undefined;
}

/** A factor verified through this business (the mirror) or, from 0064, any (C59, LF-4). */
async function factorHeld(tx: TenantQuery, subject: string, person: GatedPerson) {
  if (person.mirrored === 'true') return true;
  return person.bySubject && (await loginHasVerifiedFactor(tx, subject));
}

/** Whether an accepted invitation of this business names the person (C39-T); never another's. */
async function invited(tx: TenantQuery, personId: string): Promise<boolean> {
  const rows = await tx.query(
    `select 1 from public.invitations
      where business_id = $1 and person_id = $2 and state = 'accepted' limit 1`,
    [tx.businessId, personId],
  );
  return rows.length > 0;
}
