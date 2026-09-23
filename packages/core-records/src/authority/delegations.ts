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
// Four refusals, and the reason each is its own code rather than one shared
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
// - `DELEGATION_ALREADY_LIVE`. The agent already holds a live delegation for
//   this purpose. `delegations_one_live_per_purpose_idx` has always forbidden
//   the second row; before this it forbade it as a constraint violation, which
//   reached the caller as a 500 in process and a 503 `SERVICE_UNAVAILABLE`
//   from the served deployment, with the serving transaction aborted and so no
//   audit row for the attempt. A decision is not an outage: the duplicate is
//   read and refused here, and the index is never reached.
//
// The intersection is the whole mechanism. `effectiveGrants` is asked, inside
// the serving transaction, what the *person* holds right now; the delegation
// only ever narrows that. So revoking the person's grant collapses the agent's
// authority on its next call, and no code path can widen it, because no code
// path here reads a permission the delegation stored.

import { createHash, randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import {
  configuredCredentialKeys,
  DERIVED_SCHEME,
  type CredentialKeysDecision,
} from './credential-keys.ts';
import { effectiveGrants, type Action, type ScopeRequest } from './grants.ts';

export type DelegationRefusalCode =
  | 'DELEGATION_EXCLUDES_DECISION'
  | 'DELEGATION_OUT_OF_PURPOSE'
  | 'DELEGATION_NARROWED'
  | 'DELEGATION_NOT_LIVE'
  | 'DELEGATION_WIDENS'
  | 'DELEGATION_ALREADY_LIVE';

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
   * Returned to the authorised caller. Only its digest is stored, so the
   * database alone cannot give it back. It is derived from the delegation's
   * fixed identity under the key named in `credential_key_id`, which is what
   * lets a pickup replay recompute it (`credential-keys.ts`).
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
  keys: CredentialKeysDecision = configuredCredentialKeys(),
): Promise<DelegationDecision<MintedDelegation>> {
  // Not a decision about the caller, so not a refusal code of this module.
  // The command layer answers `DEPENDENCY_NOT_LANDED` before it gets here;
  // reaching this line without a key is a fault in whoever called it.
  if (!keys.ok) throw new Error(`delegations: no delegation credential key: ${keys.problem}`);
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

  // The one-live-per-purpose guard, read inside the serving transaction.
  //
  // The index key is `(business_id, agent_actor_id, purpose)` where
  // `revoked_at is null and settled_at is null` (0008:195). Two things follow
  // and both are load-bearing here. The key is the *purpose word*, not the
  // purpose scope, so a second mint for a sibling task under the same purpose
  // is the same duplicate; and the agent is in the key, so another agent
  // minting for the same work is not one. Expiry is **not** in the predicate,
  // so a delegation nobody settled goes on occupying the slot after it stops
  // permitting anything — which is what made R5's expired-lease recovery
  // unreachable.
  //
  // So: `for update` the blocking row, and split on whether it is still worth
  // anything. Still within its expiry, it is the agent's live authority and
  // this is a retry: refuse. Past its expiry, it is a spent authority nobody
  // closed, and settling it is the bookkeeping the index needs, done in this
  // same transaction so the insert below and the settle commit together.
  //
  // Settled rather than reused, deliberately. Reuse would hand back a
  // delegation still carrying the old credential and the old `expires_at`, so
  // the abandoned holder's credential would keep working against the fresh
  // hold — the recovery's whole point is that it does not. A new row also
  // leaves the abandoned authority legible afterwards instead of overwriting
  // it, which is what `task.read`'s projection shows beside the new hold.
  const blocking = await tx.query<{ readonly id: string; readonly expired: boolean }>(
    `select id, (expires_at <= now()) as expired from public.delegations
      where business_id = $1 and agent_actor_id = $2 and purpose = $3
        and revoked_at is null and settled_at is null
      for update`,
    [tx.businessId, request.agentActorId, request.purpose],
  );
  const held = blocking[0];
  if (held !== undefined) {
    if (!held.expired) {
      return refuse(
        'DELEGATION_ALREADY_LIVE',
        `this agent already holds a live delegation for the purpose ${request.purpose}`,
        'Use the credential already issued for it, or hand the work back so the delegation settles.',
      );
    }
    await settleDelegation(tx, held.id);
  }

  // The id is chosen here rather than by the database because the credential
  // is derived from it, and the digest has to be in the same insert.
  const id = randomUUID();
  const keyId = keys.keys.activeKeyId;
  const credential = keys.keys.derive(keyId, {
    businessId: tx.businessId,
    agentActorId: request.agentActorId,
    delegationId: id,
  });
  if (credential === undefined) throw new Error(`delegations: active key ${keyId} is not held`);
  const rows = await tx.query<DelegationRow>(
    `insert into public.delegations
       (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
        collections, actions, purpose_scope_kind, purpose_scope_id, credential_hash, expires_at,
        credential_scheme, credential_key_id)
     values ($1, $12, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $13, $14)
     on conflict (business_id, agent_actor_id, purpose)
       where revoked_at is null and settled_at is null do nothing
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
      id,
      DERIVED_SCHEME,
      keyId,
    ],
  );
  const written = rows[0];
  if (written === undefined) {
    // The read above holds a lock on a row that exists; it cannot lock one
    // that does not, so two transactions minting a first delegation for one
    // purpose can still both arrive here. `on conflict do nothing` lets the
    // loser learn that from an empty result instead of from a 23505, and the
    // answer is the same refusal the sequential duplicate gets.
    return refuse(
      'DELEGATION_ALREADY_LIVE',
      `this agent already holds a live delegation for the purpose ${request.purpose}`,
      'Use the credential already issued for it, or hand the work back so the delegation settles.',
    );
  }
  return { ok: true, value: { delegation: delegationOf(written), credential } };
}

/**
 * The delegation a presented credential names, if it is live right now.
 *
 * Looked up by agent and digest together, so a credential minted for one agent
 * cannot be presented by another. Expiry, revocation and settlement are read
 * from the row rather than trusted from the caller's clock.
 *
 * I08 (minimum contract 8.2 case 6, root ruling R-B). A delegation revoked
 * because its person lost the authority it drew on answers
 * `DELEGATION_NARROWED`, not `DELEGATION_NOT_LIVE`. The cause is the one the
 * revoking transaction recorded (`revocation_cause`, 0023), never the request
 * and never the person's grants as they read now. It is reached only through
 * the row this business, this authenticated agent and this credential digest
 * already bind, and it permits nothing: the refusal is all it changes.
 *
 * Precedence when more than one terminal fact holds: settled, then expired,
 * then the recorded revocation cause. A settled or naturally expired
 * credential is `DELEGATION_NOT_LIVE` whatever else happened to it, and so is
 * an explicit revocation, a retirement by cancellation or supersession, and a
 * revocation recorded before 0023 with no cause.
 */
export async function resolveDelegation(
  tx: TenantQuery,
  agentActorId: string,
  credential: string,
): Promise<DelegationDecision<Delegation>> {
  const rows = await tx.query<
    DelegationRow & { readonly live: boolean; readonly narrowed: boolean }
  >(
    `select id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
            collections, actions, purpose_scope_kind, purpose_scope_id, expires_at,
            (revoked_at is null and settled_at is null and expires_at > now()) as live,
            (revoked_at is not null and settled_at is null and expires_at > now()
             and revocation_cause = 'authority_lost') as narrowed
       from public.delegations
      where business_id = $1 and agent_actor_id = $2 and credential_hash = $3`,
    [tx.businessId, agentActorId, digestOf(credential)],
  );
  const found = rows[0];
  if (found?.live === true) return { ok: true, value: delegationOf(found) };
  if (found?.narrowed === true) {
    // A constant: no grant, time or person is named, and the credential is not.
    return refuse(
      'DELEGATION_NARROWED',
      'the authority this delegation drew on was removed from its delegating person',
      'the authority this delegation draws on was revoked or narrowed; ask for it again',
    );
  }
  // One refusal for unknown, expired, revoked and settled. Telling them
  // apart tells a caller holding a stolen credential which of those it is.
  return refuse(
    'DELEGATION_NOT_LIVE',
    'no live delegation answers to that credential',
    'ask the authorising person for a current delegation',
  );
}

/**
 * The delegation a presented credential named, once it has stopped being live.
 *
 * Read-only, and it permits nothing. It exists for one caller: the agent
 * entry's evidence-only handback intake (TRANSACTION-CONTRACT T4), which keeps
 * a report produced under a delegation that was since settled, revoked,
 * narrowed by authority loss or naturally expired. The row is reached through
 * the same binding `resolveDelegation` uses (this business, this
 * authenticated agent, this credential digest) and only when that binding
 * answers to no live delegation, so it never stands in for
 * `resolveDelegation` and never widens what a live credential reaches. What
 * it returns is an identity to bind a historical lease to, not an authority.
 *
 * `refusal` is the code `resolveDelegation` answered, and the row has to be
 * the one that answer came from. `DELEGATION_NARROWED` is only R-B's durable
 * cause: revoked for `authority_lost`, unsettled and unexpired, exactly the
 * `narrowed` predicate above. A live delegation whose person has since lost a
 * grant answers the same code from `checkDelegatedAuthority`, but it is still
 * live, so it is not historical and nothing is returned for it.
 */
export async function resolveHistoricalDelegation(
  tx: TenantQuery,
  agentActorId: string,
  credential: string,
  refusal: 'DELEGATION_NOT_LIVE' | 'DELEGATION_NARROWED',
): Promise<{ readonly id: string } | undefined> {
  const ended =
    refusal === 'DELEGATION_NARROWED'
      ? `revoked_at is not null and settled_at is null and expires_at > now()
         and revocation_cause = 'authority_lost'`
      : `(revoked_at is not null or settled_at is not null or expires_at <= now())`;
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.delegations
      where business_id = $1 and agent_actor_id = $2 and credential_hash = $3 and ${ended}`,
    [tx.businessId, agentActorId, digestOf(credential)],
  );
  const found = rows[0];
  return found === undefined ? undefined : { id: found.id };
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
      // The delegation's own scope only: the presented resource is not echoed,
      // so a foreign, a fabricated and a same-business id answer alike (root
      // ruling 2).
      `the purpose ${delegation.purpose} is scoped to ${scoped.kind} ${scoped.id}, ` +
        'and this call is for another resource',
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

/**
 * Why a delegation was revoked, recorded by the transaction that revoked it
 * (0023). `authority_lost` is a `grant.revoke` that left the delegating person
 * without the authority the delegation draws on; `delegation_revoked` is an
 * explicit `delegation.revoke`; `work_retired` is cancellation or
 * supersession ending the work it was issued for. Expiry and settlement are
 * their own columns and never a revocation.
 */
export type RevocationCause = 'authority_lost' | 'delegation_revoked' | 'work_retired';

/**
 * Revocation writes a timestamp and its cause, once. There is no delete path,
 * and the role has no DELETE.
 *
 * A settled delegation is already not live, so it is not revoked a second way,
 * and an already revoked one keeps the cause its first revocation recorded:
 * the first terminal write wins, which is the explicit precedence when two
 * transitions reach one delegation.
 * The answer is the timestamp this call wrote, or null when it wrote none.
 */
export async function revokeDelegation(
  tx: TenantQuery,
  delegationId: string,
  // A direct call with no cause is an explicit revocation: only the two
  // runtime transitions name another, and each names it.
  cause: RevocationCause = 'delegation_revoked',
): Promise<Date | null> {
  const rows = await tx.query<{ readonly revoked_at: Date }>(
    `update public.delegations set revoked_at = now(), revocation_cause = $3
      where business_id = $1 and id = $2 and revoked_at is null and settled_at is null
      returning revoked_at`,
    [tx.businessId, delegationId, cause],
  );
  return rows[0]?.revoked_at ?? null;
}

/** Handback settles a delegation: it stops permitting work without being a revocation. */
export async function settleDelegation(tx: TenantQuery, delegationId: string): Promise<void> {
  await tx.query(
    `update public.delegations set settled_at = now()
      where business_id = $1 and id = $2 and settled_at is null`,
    [tx.businessId, delegationId],
  );
}
