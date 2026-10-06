// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent credential at the door (API-2): the shape that tells it from a
// sign-in token, whether a presented secret is a live credential of this
// business and what it lets its agent act as, the subject it stands as, and
// a refusal recorded as an attempt. Issue and revocation are in
// `agent-credentials.ts`, beside the table they write.

import { recordAuthenticationAttempt, subjectDigest } from '../identity/authentication-attempts.ts';
import { NO_ASSURANCE, type VerifiedSubject } from '../identity/verified-subject.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { lockAccess } from './access.ts';
import { digestOf } from './delegations.ts';

/**
 * The form a credential takes: the base64url of one HMAC-SHA256, 43
 * characters and no dot. A sign-in token always has two, so the agent route
 * tells the two apart by shape alone and never hands a credential to the
 * sign-in provider's verifier.
 */
export const isAgentCredentialForm = (token: string): boolean => /^[A-Za-z0-9_-]{43}$/u.test(token);

/** What a live credential lets its agent act as, read on every call. */
export interface CredentialStanding {
  readonly credentialId: string;
  readonly agentActorId: string;
  readonly personId: string;
  readonly roleKey: string | null;
  /** The ticked `collection:action` keys. */
  readonly scope: readonly string[];
}

/** Why a presented credential is not served: one answer to the caller, whichever. */
export type CredentialNotLive = 'not-live';

/**
 * The credential a secret is, in this business, if it is live at `now`: not
 * revoked, not past its expiry, its agent actor active and its issuer still
 * a member. Found by its digest, so the secret itself is never compared or
 * kept. The row is locked `for share` for the rest of the call, so a
 * revocation (`lockAgentCredential`, `for update`) either commits first and
 * this call finds it, or waits for this call to finish.
 * The business's access lock is taken first, shared, as every holder of both takes it.
 */
export async function resolveAgentCredential(
  tx: TenantQuery,
  secret: string,
  now: Date,
): Promise<CredentialStanding | CredentialNotLive> {
  // A secret not live holds nothing (#784): screened unlocked, then resolved under the locks.
  if (!(await isAgentCredentialLive(tx, secret, now))) return 'not-live';
  await lockAccess(tx, 'shared');
  const row = await standingRow(tx, secret, 'for share of c');
  if (row === undefined || !liveAt(row, now)) return 'not-live';
  return {
    credentialId: row.id,
    agentActorId: row.agent_actor_id,
    personId: row.issued_by_person_id,
    roleKey: row.role_key,
    scope: row.scope,
  };
}

/**
 * Whether a secret is a live credential of this business at `now`, read as
 * `resolveAgentCredential` reads it but with no lock: one indexed read that
 * holds nothing and writes nothing. Only a screen; a live answer is resolved
 * again, under its lock, before it is served.
 */
export async function isAgentCredentialLive(
  tx: TenantQuery,
  secret: string,
  now: Date,
): Promise<boolean> {
  const row = await standingRow(tx, secret, '');
  return row !== undefined && liveAt(row, now);
}

interface StandingRow {
  readonly id: string;
  readonly agent_actor_id: string;
  readonly issued_by_person_id: string;
  readonly scope: readonly string[];
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly agent_active: boolean;
  readonly member: boolean;
  readonly role_key: string | null;
}

async function standingRow(
  tx: TenantQuery,
  secret: string,
  lock: 'for share of c' | '',
): Promise<StandingRow | undefined> {
  const rows = await tx.query<StandingRow>(
    `select c.id, c.agent_actor_id, c.issued_by_person_id, c.scope, c.expires_at, c.revoked_at,
            a.active as agent_active, m.id is not null as member, m.role_key
       from public.agent_credentials c
       join public.actors a on a.business_id = c.business_id and a.id = c.agent_actor_id
       left join public.memberships m
         on m.business_id = c.business_id and m.person_id = c.issued_by_person_id and m.active
      where c.business_id = $1 and c.credential_hash = $2
      ${lock}`,
    [tx.businessId, digestOf(secret)],
  );
  return rows[0];
}

const liveAt = (row: StandingRow, now: Date): boolean =>
  row.revoked_at === null &&
  now.getTime() < row.expires_at.getTime() &&
  row.agent_active &&
  row.member;

/** A credential as presented at the door: its digest, under the credential's provider. */
const presentedAs = (secret: string): VerifiedSubject => ({
  provider: 'agent-credential',
  subject: digestOf(secret),
  assurance: NO_ASSURANCE,
});

/**
 * The subject a credential stands as on the agent route, the security
 * detections included: the digest of its digest, as the attempt trail holds
 * it, and never the stored `credential_hash` or a slice of it. One credential
 * is always one subject, so its alerts count together.
 */
export const credentialSubject = (secret: string): string => subjectDigest(presentedAs(secret));

/**
 * A credential turned away is an attempt at the door (I13): recorded against
 * the digest of its digest, never the secret, owned by the delegation, in the
 * caller's transaction.
 */
export async function recordCredentialRefusal(
  tx: TenantQuery,
  secret: string,
  refusalCode: string,
): Promise<void> {
  await recordAuthenticationAttempt(tx, {
    owner: 'delegation',
    presented: presentedAs(secret),
    outcome: 'refused',
    refusalCode,
  });
}
