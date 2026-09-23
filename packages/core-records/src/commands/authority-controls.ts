// SPDX-License-Identifier: AGPL-3.0-only
//
// `grant.revoke` and `delegation.revoke`: the revocation controls, as commands.
//
// Contract ledger: "current existing grant-manager authority, within its own
// delegation ceiling ... timestamped revocation and audit; next operation
// re-evaluates". Three things follow, and this file is the second and third:
//
// 1. **The grant manager.** The declaration asks `manage` on tasks, so the
//    envelope refuses a caller who is not a manager before anything here runs.
// 2. **Its own ceiling.** A manager may revoke only a grant it could hold
//    itself: `manage` on the grant's own collection *and* the grant's own
//    (collection, action), both live and both at a scope covering the grant's.
//    For a delegation the same test runs over every (collection, action) the
//    delegation reaches, at its purpose scope. Nothing here issues, widens or
//    re-scopes anything, so no actor gains a power it did not already hold.
// 3. **Re-evaluation.** Nothing is cached. `effectiveGrants` and
//    `resolveDelegation` read `revoked_at` on every call, so the next operation
//    on the same session is refused and one already admitted finishes in the
//    transaction it was admitted in.
//
// The audit row is the envelope's: an applied command writes one naming the
// revoked row's id as its subject, and a refused one writes one with the code.
//
// F4. A revocation is also one of T5's recorded authority-loss transitions.
// The attempts it leaves without work authority are no longer claimable, so
// the same transaction releases their leases and classifies their holds
// through `classifyAuthorityLoss`, under the complete ordered lock set. Both
// handlers discover before any runtime lock and write only after it.

import type { TenantQuery } from '../tenancy/database.ts';
import {
  checkAuthority,
  effectiveGrants,
  revokeGrant,
  subjectsOf,
  type Action,
  type Scope,
} from '../authority/grants.ts';
import { revokeDelegation } from '../authority/delegations.ts';
import { classifyAuthorityLoss } from '../../../core-runtime/src/recovery.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const NOT_FOUND = refused(
  refuseCommand('NOT_FOUND', [], ['Check the identifier against the one you were given.']),
);

const absent = (field: string): HandlerOutcome =>
  refused(refuseCommand('COMMAND_BODY_INVALID', [field], [`Name the ${field} to revoke.`]));

const OUTSIDE_CEILING = refused(
  refuseCommand(
    'SCOPE_NOT_GRANTED',
    [],
    [
      'A manager revokes only what it could hold itself: manage on that collection and the same action, at a covering scope.',
      'Ask a manager whose own grants cover it.',
    ],
  ),
);

/** Whether the caller holds `action` on `collection` at a scope covering `scope`. */
async function holds(
  tx: TenantQuery,
  context: CommandContext,
  collection: string,
  action: Action,
  scope: Scope,
): Promise<boolean> {
  const held = await effectiveGrants(tx, subjectsOf(context.session), {
    collection,
    action,
    scope,
  });
  return held.length > 0;
}

/** Manager of the collection and holder of the pair: the revoker's ceiling. */
async function withinCeiling(
  tx: TenantQuery,
  context: CommandContext,
  collection: string,
  action: Action,
  scope: Scope,
): Promise<boolean> {
  return (
    (await holds(tx, context, collection, 'manage', scope)) &&
    (await holds(tx, context, collection, action, scope))
  );
}

/** A live attempt drawing on a person the revoked grant may have covered. */
interface Dependent {
  readonly delegation_id: string;
  readonly person_id: string;
  readonly task_id: string;
  readonly collections: readonly string[];
}

/**
 * Read-only: the live leases whose delegating person the grant, or a grant
 * derived from it, names. A revocation collapses what the revoked grant
 * issued (`grants.ts`), so its descendants' subjects are candidates too.
 * `write` only, because that is the work authority an attempt draws on; and
 * `person` only, because a delegation's ceiling is its person's own grants
 * (`checkDelegatedAuthority`). A candidate is not yet a loss: the person may
 * hold write through another grant, which is re-read under the locks.
 */
async function dependents(tx: TenantQuery, grantId: string): Promise<readonly Dependent[]> {
  return await tx.query<Dependent>(
    `with recursive revoked as (
       select g.id, g.subject_kind, g.subject_id, g.collection, g.action
         from public.grants g where g.business_id = $1 and g.id = $2
       union
       select c.id, c.subject_kind, c.subject_id, c.collection, c.action
         from public.grants c join revoked p on c.parent_grant_id = p.id
        where c.business_id = $1
     )
     select l.delegation_id, l.authorised_by_person_id as person_id, l.task_id, d.collections
       from public.leases l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.business_id = $1 and l.state = 'live'
        and d.revoked_at is null and d.settled_at is null
        and exists (select 1 from revoked r
                     where r.subject_kind = 'person' and r.subject_id = l.authorised_by_person_id
                       and r.action = 'write' and r.collection = any(d.collections))
      order by l.delegation_id, l.task_id`,
    [tx.businessId, grantId],
  );
}

/** Whether the delegating person still holds write on the attempt's task, in every collection. */
async function stillAuthorised(tx: TenantQuery, dependent: Dependent): Promise<boolean> {
  for (const collection of dependent.collections) {
    // eslint-disable-next-line no-await-in-loop -- one collection per delegation today
    const held = await checkAuthority(tx, [{ kind: 'person', id: dependent.person_id }], {
      collection,
      action: 'write',
      scope: { kind: 'record', id: dependent.task_id },
    });
    if (!held.ok) return false;
  }
  return true;
}

export async function revokeGrantAsManager(
  tx: TenantQuery,
  context: CommandContext,
  grantId: unknown,
): Promise<HandlerOutcome> {
  if (typeof grantId !== 'string') return absent('grantId');
  if (!UUID.test(grantId)) return NOT_FOUND;
  const rows = await tx.query<{
    readonly collection: string;
    readonly action: Action;
    readonly scope_kind: Scope['kind'];
    readonly scope_id: string | null;
    readonly revoked: boolean;
  }>(
    // F4. Locked before the runtime set, and that is outside the global order
    // on purpose rather than by accident: `grants` is not a class in it, and
    // no runtime operation locks a grant row (pickup and every delegated call
    // read grants without one), so a transaction holding runtime locks never
    // waits on this row and no cycle can close through it. What it buys is
    // that two revocations of one grant serialise here, before either has
    // discovered or locked any work.
    `select collection, action, scope_kind, scope_id, (revoked_at is not null) as revoked
       from public.grants where business_id = $1 and id = $2 for update`,
    [tx.businessId, grantId],
  );
  const grant = rows[0];
  if (grant === undefined) return NOT_FOUND;
  const scope: Scope = { kind: grant.scope_kind, id: grant.scope_id };
  if (!(await withinCeiling(tx, context, grant.collection, grant.action, scope))) {
    return OUTSIDE_CEILING;
  }
  const already = refused(
    refuseCommand(
      'TRANSITION_NOT_PERMITTED',
      ['revoked'],
      ['This grant is already revoked. A revocation is written once and never undone.'],
    ),
  );
  if (grant.revoked) return already;

  const candidates = await dependents(tx, grantId);
  const loss = await classifyAuthorityLoss(tx, {
    delegationIds: candidates.map((each) => each.delegation_id),
    revoke: async () => {
      // The candidate set is part of the lock set, so it is rechecked like
      // the rest of it: a pickup that committed in between is a lease these
      // locks do not cover.
      const current = await dependents(tx, grantId);
      if (JSON.stringify(current) !== JSON.stringify(candidates)) {
        throw new Error(
          'grant.revoke: the dependent attempts changed under discovery; roll back and rediscover rather than extending the lock set',
        );
      }
      const revokedAt = await revokeGrant(tx, grantId);
      if (revokedAt === null) return { applied: false, value: null };
      // Re-evaluated after the revocation and under the locks: only an
      // attempt whose person now holds no write on its task has lost its
      // work authority. One still covered by another live grant is untouched.
      const lost: string[] = [];
      for (const dependent of current) {
        // eslint-disable-next-line no-await-in-loop -- one per live attempt, each decisive
        if (!(await stillAuthorised(tx, dependent))) lost.push(dependent.delegation_id);
      }
      return { applied: true, value: revokedAt, lost };
    },
  });
  if (!loss.applied || loss.value === null) return already;
  return applied(grantId, null, { grantId, revokedAt: loss.value.toISOString() });
}

export async function revokeDelegationAsManager(
  tx: TenantQuery,
  context: CommandContext,
  delegationId: unknown,
): Promise<HandlerOutcome> {
  if (typeof delegationId !== 'string') return absent('delegationId');
  if (!UUID.test(delegationId)) return NOT_FOUND;
  const rows = await tx.query<{
    readonly collections: readonly string[];
    readonly actions: readonly Action[];
    readonly purpose_scope_kind: Scope['kind'];
    readonly purpose_scope_id: string | null;
  }>(
    // F4. Discovery, not a lock. The delegation is a class in the global
    // order after cap, envelope, task, run, lineage and lease, so locking it
    // here and then taking those would be the backwards acquisition the
    // contract forbids. These columns are written once at mint; whether the
    // row is still live is read again under the complete set below.
    `select collections, actions, purpose_scope_kind, purpose_scope_id
       from public.delegations where business_id = $1 and id = $2`,
    [tx.businessId, delegationId],
  );
  const delegation = rows[0];
  if (delegation === undefined) return NOT_FOUND;
  const scope: Scope = { kind: delegation.purpose_scope_kind, id: delegation.purpose_scope_id };
  for (const collection of delegation.collections) {
    for (const action of delegation.actions) {
      // eslint-disable-next-line no-await-in-loop -- a handful of pairs, each one decisive
      if (!(await withinCeiling(tx, context, collection, action, scope))) return OUTSIDE_CEILING;
    }
  }

  const loss = await classifyAuthorityLoss(tx, {
    delegationIds: [delegationId],
    revoke: async () => {
      const live = await tx.query<{ readonly live: boolean }>(
        `select (revoked_at is null and settled_at is null and expires_at > now()) as live
           from public.delegations where business_id = $1 and id = $2`,
        [tx.businessId, delegationId],
      );
      const revokedAt = live[0]?.live === true ? await revokeDelegation(tx, delegationId) : null;
      return revokedAt === null
        ? { applied: false, value: null }
        : { applied: true, value: revokedAt, lost: [delegationId] };
    },
  });
  const revokedAt = loss.value;
  if (!loss.applied || revokedAt === null) {
    return refused(
      refuseCommand(
        'DELEGATION_NOT_LIVE',
        [],
        [
          'This delegation is already revoked, settled or expired; there is nothing left to revoke.',
        ],
      ),
    );
  }
  return applied(delegationId, null, { delegationId, revokedAt: revokedAt.toISOString() });
}
