// SPDX-License-Identifier: AGPL-3.0-only
//
// Every authentication attempt, kept where the domain audit is not.
//
// The ledger asks for a separate authentication-attempt owner (I13). The
// domain audit records what a command did, in a chain bound to a business's
// operations; this records who got through the door and who did not. Different
// question, different retention answer, different reader — and, on the
// refusals, a row for an attempt that never became an operation and so has no
// audit event to hang off.
//
// The presented subject is stored as a digest and never whole. A refused
// attempt carries a subject this business has no relationship with; storing it
// raw would make this table a place to park an identifier in a tenant that
// never agreed to hold it, which is the leak I13's own negative names. On
// success the verified subject is this business's own login and actor rows,
// which is what "the verified subject" means in product terms.
//
// The write shares the caller's transaction. A refusal and its record commit
// together, so there is no path on which the server turned someone away and
// forgot it.

import { createHash } from 'node:crypto';
import type { BusinessId, Database, TenantQuery } from '../tenancy/database.ts';
import type { VerifiedSubject } from './verified-subject.ts';

export type AttemptOwner = 'person_login' | 'agent_login' | 'delegation';

export interface ResolvedAttempt {
  readonly owner: AttemptOwner;
  readonly presented: VerifiedSubject;
  readonly outcome: 'resolved';
  readonly loginId: string;
  readonly actorId: string;
  readonly personId?: string;
}

export interface RefusedAttempt {
  readonly owner: AttemptOwner;
  readonly presented: VerifiedSubject;
  readonly outcome: 'refused';
  /** The code, never a sentence, and never a value the caller did not present. */
  readonly refusalCode: string;
}

export type AuthenticationAttempt = ResolvedAttempt | RefusedAttempt;

export function subjectDigest(presented: VerifiedSubject): string {
  return createHash('sha256')
    .update(`${presented.provider}\u0000${presented.subject}`, 'utf8')
    .digest('hex');
}

/**
 * Record one attempt. Append only: the role has INSERT and SELECT here and no
 * UPDATE, so a trail that has been amended is not a trail this code produced.
 */
export async function recordAuthenticationAttempt(
  tx: TenantQuery,
  attempt: AuthenticationAttempt,
): Promise<void> {
  const resolved = attempt.outcome === 'resolved';
  await tx.query(
    `insert into public.authentication_attempts
       (business_id, id, owner, provider, subject_digest, outcome,
        login_id, actor_id, person_id, refusal_code)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tx.businessId,
      attempt.owner,
      attempt.presented.provider,
      subjectDigest(attempt.presented),
      attempt.outcome,
      resolved ? attempt.loginId : null,
      resolved ? attempt.actorId : null,
      resolved ? (attempt.personId ?? null) : null,
      resolved ? null : attempt.refusalCode,
    ],
  );
}

/**
 * A body the boundary could not read as a JSON object, recorded as the
 * admission refusal it is (root ruling 4).
 *
 * It arrives after the bearer is verified and the business key is resolved by
 * the server, and before anyone has asked who the subject is in that
 * business, so there is no domain actor to write an audit event for and
 * inventing one would put a name in the chain that nobody acted under. What
 * is known is exactly what this table holds: the business, which door, the
 * provider and the subject's digest. The reason is the real one,
 * `COMMAND_BODY_INVALID`, not a credential failure that did not happen. The
 * body and the bearer are stored nowhere: the row has no column for either.
 *
 * Its own transaction under the tenancy wrapper, because no operation is going
 * to open one: the request ends here.
 *
 * An expired bearer is no verified subject. The agent prefix hands one on to
 * its executor and so reaches the body check with it; it is refused exactly
 * as before and nothing is written, because there is nobody to write it for.
 */
export async function recordBodyRefusal(
  database: Database,
  businessId: BusinessId,
  owner: Exclude<AttemptOwner, 'delegation'>,
  presented: VerifiedSubject | 'expired',
): Promise<void> {
  if (presented === 'expired') return;
  await database.withBusiness(businessId, async (tx) => {
    await recordAuthenticationAttempt(tx, {
      owner,
      presented,
      outcome: 'refused',
      refusalCode: 'COMMAND_BODY_INVALID',
    });
  });
}

export interface AttemptRow {
  readonly id: string;
  readonly at: Date;
  readonly owner: AttemptOwner;
  readonly provider: string;
  readonly subject_digest: string;
  readonly outcome: 'resolved' | 'refused';
  readonly login_id: string | null;
  readonly actor_id: string | null;
  readonly person_id: string | null;
  readonly refusal_code: string | null;
}

/** The trail for one presented subject, newest first. Tenant-scoped like everything else. */
export async function readAuthenticationAttempts(
  tx: TenantQuery,
  presented: VerifiedSubject,
): Promise<readonly AttemptRow[]> {
  return await tx.query<AttemptRow>(
    `select id, at, owner, provider, subject_digest, outcome, login_id, actor_id,
            person_id, refusal_code
       from public.authentication_attempts
      where business_id = $1 and provider = $2 and subject_digest = $3
      order by at desc, id`,
    [tx.businessId, presented.provider, subjectDigest(presented)],
  );
}
