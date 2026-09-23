// SPDX-License-Identifier: AGPL-3.0-only
//
// What the signed-in person may do here, answered from the grant model.
//
// Every surface needs this and every surface was guessing at it. A screen that
// draws a button from a role name draws it for a person whose grant was
// revoked this morning, and a client that discovers the truth from a 403 has
// already told the person they could do the thing. The answer is the same
// `effectiveGrants` the authority check runs, in the caller's transaction, so
// a grant revoked a moment ago is missing from this list rather than soon.
//
// **Three things this never returns.** Not a secret: a grant is a pair of
// words, and nothing about a credential, a delegation's credential digest or a
// signing key is reachable from here. Not another person's grants: the
// subjects are `subjectsOf(session)` and nothing takes a person identifier
// from a caller, so there is no parameter to point at somebody else. Not a
// decision: it reports authority, it does not confer it, and every operation
// still asks `checkAuthority` for itself.
//
// **It needs no grant beyond membership.** A caller who could not read this
// could still discover every pair in it by attempting the operations one at a
// time, so gating it would cost a round trip and buy nothing. A login with no
// membership never reaches here at all — that is `AUTH_NO_MEMBERSHIP` from the
// resolution, before any read runs.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Session } from '../identity/login-resolution.ts';
import { effectiveGrants, subjectsOf, type Action, type ScopeKind } from '../authority/grants.ts';

/** One thing the caller may do, as the grant model spells it. */
export interface Capability {
  readonly collection: string;
  readonly action: Action;
}

/**
 * The person answer, flattened onto the read result rather than nested.
 *
 * The three fields sit beside `ok` on the wire -- `{ ok: true, personId,
 * businessKey, grants }` -- because that is the shape the surfaces are being
 * written against, and a nested `capabilities` object would have made every
 * client reach through one more level for three fields.
 */
export interface SessionCapabilities {
  readonly personId: string;
  /** The business's key, which is what a path and a screen both name it by. */
  readonly businessKey: string;
  /** Distinct pairs, sorted. A pair held at two scopes appears once. */
  readonly grants: readonly Capability[];
}

/**
 * The agent half of the same question.
 *
 * An agent holds no grants of its own — `identity/agent-login.ts` confers
 * nothing at all — so the honest answer is its delegation's purpose and the
 * two operations it may reach before it has one. Reporting the delegating
 * person's grants here would be reporting somebody else's authority as the
 * agent's, which is the collapse the identity model exists to prevent.
 */
export interface AgentCapabilities {
  /** Its own acting identity. Never the delegating person's. */
  readonly agentActorId: string;
  readonly businessKey: string;
  /** The picked-up task the delegation is bounded to, or null before a pickup. */
  readonly purposeScope: { readonly kind: 'record'; readonly id: string } | null;
  /**
   * The authority the two pre-pickup operations take, as the same
   * `{ collection, action }` pairs the person answer uses.
   *
   * `task.queue` and `task.pickup` are the two an agent may reach holding
   * nothing, and their declarations take `read` and `write` on `task`. The
   * pairs are what this field carries rather than the operation names, so one
   * client can read `grants` the same way on both prefixes; the names are in
   * `agent-envelope.ts`'s `BEFORE_PICKUP` and in `docs/local/API.md`.
   */
  readonly grants: readonly Capability[];
}

// The pre-pickup pair itself is `agent-envelope.ts`'s `BEFORE_PICKUP` and it is
// filled in there rather than imported here. The agent envelope already reads
// `reads/queue.ts` and `reads/tasks.ts`, so a read module reaching back into it
// would close an import cycle for the sake of one constant.

interface CandidateRow {
  readonly collection: string;
  readonly action: Action;
  readonly scope_kind: ScopeKind;
  readonly scope_id: string | null;
}

/**
 * The caller's live capabilities, in their own transaction.
 *
 * Two steps, and the first is deliberately not the authority. `public.grants`
 * is asked which pairs are worth asking about — a cheap narrowing over rows
 * that are not revoked and not expired — and then `effectiveGrants` decides
 * each one, because it is the single expression of "live, and still covered by
 * its granter" and a delegated grant whose parent was revoked is live in the
 * table and dead in that query. Reproducing its recursive term here would put
 * a second copy of the authority model in the read layer, which is exactly
 * what a capability read must not be.
 */
export async function readCapabilities(
  tx: TenantQuery,
  session: Session,
): Promise<SessionCapabilities> {
  const subjects = subjectsOf(session);
  const candidates = await tx.query<CandidateRow>(
    `select distinct collection, action, scope_kind, scope_id
       from public.grants
      where business_id = $1
        and revoked_at is null
        and (expires_at is null or expires_at > now())
        and exists (select 1 from unnest($2::text[], $3::uuid[]) as s (kind, id)
                     where s.kind = subject_kind and s.id = subject_id)`,
    [tx.businessId, subjects.map((subject) => subject.kind), subjects.map((subject) => subject.id)],
  );

  const held = new Map<string, Capability>();
  for (const candidate of candidates) {
    // Sequential: one transaction, one connection, and the candidate list is
    // the pairs one person holds rather than the business's whole grant table.
    // oxlint-disable-next-line no-await-in-loop
    const live = await effectiveGrants(tx, subjects, {
      collection: candidate.collection,
      action: candidate.action,
      scope: { kind: candidate.scope_kind, id: candidate.scope_id },
    });
    if (live.length === 0) continue;
    held.set(`${candidate.collection}:${candidate.action}`, {
      collection: candidate.collection,
      action: candidate.action,
    });
  }

  return {
    personId: session.personId,
    businessKey: await businessKeyOf(tx),
    grants: [...held.keys()].toSorted().map((pair) => held.get(pair) as Capability),
  };
}

/**
 * The key, not the identifier.
 *
 * A caller already knows the key: it is in the path it just called. Handing
 * back the uuid instead would give a client an identifier it has no other use
 * for and would make the answer harder to check against the request.
 */
export async function businessKeyOf(tx: TenantQuery): Promise<string> {
  const rows = await tx.query<{ readonly key: string }>(
    `select key from public.businesses where business_id = $1 and id = $1`,
    [tx.businessId],
  );
  const found = rows[0];
  if (found === undefined) {
    throw new Error('readCapabilities: the session’s business has no row of its own');
  }
  return found.key;
}
