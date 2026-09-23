// SPDX-License-Identifier: AGPL-3.0-only
//
// Purpose delegation: what an agent may do, computed on every call.
//
// A delegation is a recorded authorisation, not a permission set. It names an
// agent, the person whose authority it draws on, a purpose, and the
// collections and actions that purpose reaches. It carries no grant of its
// own, so there is nothing here to go stale (transaction contract,
// delegation).
//
// Three refusals, and the reason each is its own code rather than one shared
// denial.
//
// - `DELEGATION_EXCLUDES_DECISION` (I07). A person decides. A delegated agent
//   is refused on that ground, not as an ungranted scope, because "you may not
//   decide" and "nobody granted you this" send a caller to two different
//   places and only one of them is the truth.
// - `DELEGATION_OUT_OF_PURPOSE`. The purpose does not reach the call. Checked
//   before any grant is read, so an agent probing outside its purpose learns
//   nothing about what its person holds.
// - `DELEGATION_NARROWED` (I08). The purpose reaches the call and the
//   delegating person's live grants no longer cover it. This is the code the
//   ledger requires by name: substituting `SCOPE_NOT_GRANTED` here would say
//   the agent was never authorised, when what happened is that the authority
//   it was drawing on was taken away.
//
// The intersection is the whole mechanism. `effectiveGrants` is asked, inside
// the serving transaction, what the *person* holds right now; the delegation
// only ever narrows that. So revoking the person's grant collapses the agent's
// authority on its next call, and no code path can widen it, because no code
// path here reads a permission the delegation stored.

import { createHash, randomBytes } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { effectiveGrants, type Action, type ScopeRequest } from './grants.ts';

export type DelegationRefusalCode =
  | 'DELEGATION_EXCLUDES_DECISION'
  | 'DELEGATION_OUT_OF_PURPOSE'
  | 'DELEGATION_NARROWED'
  | 'DELEGATION_NOT_LIVE'
  | 'DELEGATION_WIDENS';

/** The same shape `grants.ts` returns, with this module's codes. Returned, never thrown. */
export type DelegationDecision<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: DelegationRefusal };

export interface DelegationRefusal {
  readonly code: DelegationRefusalCode;
  readonly reason: string;
  readonly fix: string;
}

/** The actions a delegation may carry. `decide` is not one of them (I07). */
export type DelegableAction = Exclude<Action, 'decide'>;

/**
 * The one resource a delegation was minted for.
 *
 * `record` only, and mandatory. R5 is "R1's delegated agent, purpose-scoped to
 * one task": the purpose is a ceiling on *what*, not only on which collections
 * and actions. Record- or actor-scoped minting stays deferred, so this admits
 * no other kind rather than pretending to support one.
 */
export interface PurposeScope {
  readonly kind: 'record';
  readonly id: string;
}

export interface Delegation {
  readonly id: string;
  readonly agentActorId: string;
  /** The person whose live grants are the ceiling. Never a copy of them. */
  readonly delegatePersonId: string;
  readonly mintedByActorId: string;
  readonly purpose: string;
  readonly collections: readonly string[];
  readonly actions: readonly DelegableAction[];
  /** The task this delegation is for. Every call is intersected with it. */
  readonly purposeScope: PurposeScope;
  readonly expiresAt: Date;
}

export interface MintRequest {
  readonly agentActorId: string;
  readonly delegatePersonId: string;
  /** The authorising person's acting identity, not the requesting agent's. */
  readonly mintedByActorId: string;
  readonly purpose: string;
  readonly collections: readonly string[];
  readonly actions: readonly Action[];
  /** The picked-up task's record id. Mandatory: there is no unscoped purpose. */
  readonly purposeScope: PurposeScope;
  readonly expiresAt: Date;
}

export interface MintedDelegation {
  readonly delegation: Delegation;
  /**
   * Returned once, to the authorised caller. Only its digest is stored, so
   * this value cannot be recovered from the database afterwards.
   */
  readonly credential: string;
}

interface DelegationRow {
  readonly id: string;
  readonly agent_actor_id: string;
  readonly delegate_person_id: string;
  readonly minted_by_actor_id: string;
  readonly purpose: string;
  readonly collections: readonly string[];
  readonly actions: readonly DelegableAction[];
  readonly purpose_scope_kind: 'record';
  readonly purpose_scope_id: string;
  readonly expires_at: Date;
}

const DECISION_FIX = 'A person decides. Propose the change and let one of them decide it.';

function refuse(
  code: DelegationRefusalCode,
  reason: string,
  fix: string,
): DelegationDecision<never> {
  return { ok: false, refusal: { code, reason, fix } };
}

export function digestOf(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

function delegationOf(row: DelegationRow): Delegation {
  return {
    id: row.id,
    agentActorId: row.agent_actor_id,
    delegatePersonId: row.delegate_person_id,
    mintedByActorId: row.minted_by_actor_id,
    purpose: row.purpose,
    collections: row.collections,
    actions: row.actions,
    purposeScope: { kind: row.purpose_scope_kind, id: row.purpose_scope_id },
    expiresAt: row.expires_at,
  };
}

/**
 * Mint one, against a person's recorded authorisation.
 *
 * The agent does not choose the person and cannot widen the purpose: both
 * arrive from the authorisation the person recorded, and every action asked
 * for is checked against what that person actually holds right now. A
 * delegation that asks for more than its person has is `DELEGATION_WIDENS`
 * here and would be narrowed on every call anyway — refusing at mint time
 * means the agent is told at the point it could still be fixed.
 */
export async function mintDelegation(
  tx: TenantQuery,
  request: MintRequest,
): Promise<DelegationDecision<MintedDelegation>> {
  if (request.actions.includes('decide')) {
    return refuse(
      'DELEGATION_EXCLUDES_DECISION',
      'a delegation never carries decide',
      DECISION_FIX,
    );
  }

  const person = [{ kind: 'person', id: request.delegatePersonId }] as const;
  for (const collection of request.collections) {
    for (const action of request.actions) {
      // Sequential on purpose: one transaction, one connection, and a refusal
      // that names the first pair the person does not hold.
      // oxlint-disable-next-line no-await-in-loop
      const held = await effectiveGrants(tx, person, {
        collection,
        action,
        scope: { kind: 'business', id: null },
      });
      if (held.length === 0) {
        return refuse(
          'DELEGATION_WIDENS',
          `the delegating person holds no live ${action} grant on ${collection}`,
          'narrow the purpose, or grant the person that authority first',
        );
      }
    }
  }

  const credential = randomBytes(32).toString('base64url');
  const rows = await tx.query<DelegationRow>(
    `insert into public.delegations
       (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
        collections, actions, purpose_scope_kind, purpose_scope_id, credential_hash, expires_at)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
               collections, actions, purpose_scope_kind, purpose_scope_id, expires_at`,
    [
      tx.businessId,
      request.agentActorId,
      request.delegatePersonId,
      request.mintedByActorId,
      request.purpose,
      request.collections,
      request.actions,
      request.purposeScope.kind,
      request.purposeScope.id,
      digestOf(credential),
      request.expiresAt,
    ],
  );
  const written = rows[0];
  if (written === undefined) throw new Error('mintDelegation: the insert returned no row');
  return { ok: true, value: { delegation: delegationOf(written), credential } };
}

/**
 * The delegation a presented credential names, if it is live right now.
 *
 * Looked up by agent and digest together, so a credential minted for one agent
 * cannot be presented by another. Expiry, revocation and settlement are read
 * from the row rather than trusted from the caller's clock.
 */
export async function resolveDelegation(
  tx: TenantQuery,
  agentActorId: string,
  credential: string,
): Promise<DelegationDecision<Delegation>> {
  const rows = await tx.query<DelegationRow>(
    `select id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
            collections, actions, purpose_scope_kind, purpose_scope_id, expires_at
       from public.delegations
      where business_id = $1 and agent_actor_id = $2 and credential_hash = $3
        and revoked_at is null and settled_at is null and expires_at > now()`,
    [tx.businessId, agentActorId, digestOf(credential)],
  );
  const found = rows[0];
  if (found === undefined) {
    // One refusal for unknown, expired, revoked and settled. Telling them
    // apart tells a caller holding a stolen credential which of those it is.
    return refuse(
      'DELEGATION_NOT_LIVE',
      'no live delegation answers to that credential',
      'ask the authorising person for a current delegation',
    );
  }
  return { ok: true, value: delegationOf(found) };
}

/**
 * What this delegation permits for this call, right now.
 *
 * Order matters and is the point. The decision exclusion first, so it is never
 * reported as something else. The purpose next, so an out-of-purpose probe
 * reads no grant. The person's live grants last, and their absence is
 * `DELEGATION_NARROWED` by name.
 */
export async function checkDelegatedAuthority(
  tx: TenantQuery,
  delegation: Delegation,
  request: ScopeRequest,
): Promise<DelegationDecision<readonly string[]>> {
  if (request.action === 'decide') {
    return refuse(
      'DELEGATION_EXCLUDES_DECISION',
      `the purpose ${delegation.purpose} does not carry decide, and no purpose does`,
      DECISION_FIX,
    );
  }
  if (!delegation.collections.includes(request.collection)) {
    return refuse(
      'DELEGATION_OUT_OF_PURPOSE',
      `the purpose ${delegation.purpose} does not reach ${request.collection}`,
      'ask the authorising person for a delegation whose purpose covers it',
    );
  }
  if (!delegation.actions.includes(request.action as DelegableAction)) {
    return refuse(
      'DELEGATION_OUT_OF_PURPOSE',
      `the purpose ${delegation.purpose} does not carry ${request.action}`,
      'ask the authorising person for a delegation whose purpose covers it',
    );
  }
  // The one-task ceiling. The person's own grant is ordinarily business-wide,
  // so without this a call on a sibling task reaches the same grant and passes
  // exactly as a call on the picked-up task does. `exactly` is the word: a
  // business- or party-scoped request under a delegation is outside it too,
  // because a delegation narrower than its person cannot answer wider than the
  // resource it was minted for.
  const scoped = delegation.purposeScope;
  if (request.scope.kind !== scoped.kind || request.scope.id !== scoped.id) {
    return refuse(
      'DELEGATION_OUT_OF_PURPOSE',
      `the purpose ${delegation.purpose} is scoped to ${scoped.kind} ${scoped.id}, ` +
        `and this call is for ${request.scope.kind} ${request.scope.id ?? 'the whole business'}`,
      'ask the authorising person for a delegation minted for that record',
    );
  }

  const held = await effectiveGrants(
    tx,
    [{ kind: 'person', id: delegation.delegatePersonId }],
    request,
  );
  if (held.length === 0) {
    return refuse(
      'DELEGATION_NARROWED',
      `the delegating person holds no live grant for ${request.action} on ` +
        `${request.collection}; this delegation is narrowed to what they hold`,
      'the authority this delegation draws on was revoked or narrowed; ask for it again',
    );
  }
  return { ok: true, value: held.map((grant) => grant.id) };
}

/** Revocation writes a timestamp. There is no delete path, and the role has no DELETE. */
export async function revokeDelegation(tx: TenantQuery, delegationId: string): Promise<void> {
  await tx.query(
    `update public.delegations set revoked_at = now()
      where business_id = $1 and id = $2 and revoked_at is null`,
    [tx.businessId, delegationId],
  );
}

/** Handback settles a delegation: it stops permitting work without being a revocation. */
export async function settleDelegation(tx: TenantQuery, delegationId: string): Promise<void> {
  await tx.query(
    `update public.delegations set settled_at = now()
      where business_id = $1 and id = $2 and settled_at is null`,
    [tx.businessId, delegationId],
  );
}
