// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent credential (API-2): a standing delegation from the person who
// issues it to a fresh agent actor of theirs, with no lease and no run. The
// table is `public.agent_credentials` (migration 0052).
//
// **Scope.** The ticked `collection:action` keys, each one the issuer holds at
// business scope when it is issued (the grant check's own walk), and never
// decide, share or manage, whatever they hold. **Expiry.** At most
// `CREDENTIAL_MAX_DAYS` from issue; the limit is set here and nowhere else.
//
// **The secret.** Derived as a delegation's credential is, HMAC-SHA256 under
// the delegation credential key (`credential-keys.ts`), in the agent
// credential's own domain, over the business, the agent actor and the
// credential's id. The row keeps its SHA-256, the scheme and the key id; the
// secret itself is in the issue answer only, and an issuer's replay of that
// same issue derives it again rather than reading it from anywhere.
//
// **Revocation** locks the row and sets it once. The issuer revokes their own;
// anyone else needs `access:manage`, which the command asks before this runs.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import {
  AGENT_CREDENTIAL_DOMAIN,
  DERIVED_SCHEME,
  type DelegationCredentialKeys,
} from './credential-keys.ts';
import { digestOf } from './delegations.ts';
import type { Action } from './grants.ts';

/** The longest an agent credential lives, in days from issue. The one place it is set. */
export const CREDENTIAL_MAX_DAYS = 90;

/** What an agent credential never carries, whatever its issuer holds. */
export const CREDENTIAL_EXCLUDED_ACTIONS: readonly Action[] = ['decide', 'share', 'manage'];

export interface CredentialKey {
  readonly collection: string;
  readonly action: Action;
}

export interface IssueCredential {
  readonly personId: string;
  readonly actorId: string;
  readonly purpose: string;
  readonly scope: readonly CredentialKey[];
  readonly expiresAt: Date;
}

export interface IssuedCredential {
  readonly credentialId: string;
  readonly agentActorId: string;
  /** In the clear here only; the row holds its digest. */
  readonly credential: string;
}

/** A stored agent credential, never its secret or its digest. */
export interface AgentCredential {
  readonly id: string;
  readonly agentActorId: string;
  readonly issuedByPersonId: string;
  readonly keyId: string;
  readonly credentialHash: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export type CredentialRefusal = 'not-found' | 'already-revoked';

const keyOf = (key: CredentialKey): string => `${key.collection}:${key.action}`;

/** The secret of one agent credential, under the named key, or undefined without it. */
export function deriveAgentCredential(
  keys: DelegationCredentialKeys,
  keyId: string,
  businessId: string,
  row: { readonly id: string; readonly agentActorId: string },
): string | undefined {
  return keys.derive(keyId, {
    businessId,
    agentActorId: row.agentActorId,
    delegationId: row.id,
    domain: AGENT_CREDENTIAL_DOMAIN,
  });
}

/**
 * A fresh agent actor, then the credential for it, in the caller's
 * transaction. The ids are chosen here because the secret is derived from
 * them and its digest goes into the same insert.
 */
export async function issueAgentCredential(
  tx: TenantQuery,
  keys: DelegationCredentialKeys,
  request: IssueCredential,
): Promise<IssuedCredential> {
  const credentialId = randomUUID();
  const agentActorId = randomUUID();
  const keyId = keys.activeKeyId;
  const credential = deriveAgentCredential(keys, keyId, tx.businessId, {
    id: credentialId,
    agentActorId,
  });
  if (credential === undefined)
    throw new Error(`agent-credentials: active key ${keyId} is not held`);
  await tx.query(
    `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'agent', null)`,
    [tx.businessId, agentActorId],
  );
  await tx.query(
    `insert into public.agent_credentials
       (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
        credential_hash, credential_scheme, credential_key_id, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      tx.businessId,
      credentialId,
      agentActorId,
      request.personId,
      request.actorId,
      request.purpose,
      request.scope.map(keyOf),
      digestOf(credential),
      DERIVED_SCHEME,
      keyId,
      request.expiresAt,
    ],
  );
  return { credentialId, agentActorId, credential };
}

/** One credential of this business, locked for the caller's decision, or undefined. */
export async function lockAgentCredential(
  tx: TenantQuery,
  credentialId: string,
): Promise<AgentCredential | undefined> {
  const rows = await tx.query<{
    readonly id: string;
    readonly agent_actor_id: string;
    readonly issued_by_person_id: string;
    readonly credential_key_id: string;
    readonly credential_hash: string;
    readonly expires_at: Date;
    readonly revoked_at: Date | null;
  }>(
    `select id, agent_actor_id, issued_by_person_id, credential_key_id, credential_hash,
            expires_at, revoked_at
       from public.agent_credentials
      where business_id = $1 and id = $2
      for update`,
    [tx.businessId, credentialId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    agentActorId: row.agent_actor_id,
    issuedByPersonId: row.issued_by_person_id,
    keyId: row.credential_key_id,
    credentialHash: row.credential_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Revoke a credential already locked by `lockAgentCredential`, and deactivate
 * its agent actor with it. Once: a second revocation is refused.
 */
export async function revokeAgentCredential(
  tx: TenantQuery,
  held: AgentCredential,
  byActorId: string,
): Promise<CredentialRefusal | undefined> {
  if (held.revokedAt !== null) return 'already-revoked';
  await tx.query(
    `update public.agent_credentials
        set revoked_at = clock_timestamp(), revoked_by_actor_id = $3
      where business_id = $1 and id = $2`,
    [tx.businessId, held.id, byActorId],
  );
  await tx.query(
    `update public.actors set active = false, deactivated_at = clock_timestamp()
      where business_id = $1 and id = $2 and active`,
    [tx.businessId, held.agentActorId],
  );
  return undefined;
}
