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

import type { TenantQuery } from '../tenancy/database.ts';
import {
  effectiveGrants,
  revokeGrant,
  subjectsOf,
  type Action,
  type Scope,
} from '../authority/grants.ts';
import { revokeDelegation } from '../authority/delegations.ts';
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

  const revokedAt = grant.revoked ? null : await revokeGrant(tx, grantId);
  if (revokedAt === null) {
    return refused(
      refuseCommand(
        'TRANSITION_NOT_PERMITTED',
        ['revoked'],
        ['This grant is already revoked. A revocation is written once and never undone.'],
      ),
    );
  }
  return applied(grantId, null, { grantId, revokedAt: revokedAt.toISOString() });
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
    readonly live: boolean;
  }>(
    `select collections, actions, purpose_scope_kind, purpose_scope_id,
            (revoked_at is null and settled_at is null and expires_at > now()) as live
       from public.delegations where business_id = $1 and id = $2 for update`,
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

  const revokedAt = delegation.live ? await revokeDelegation(tx, delegationId) : null;
  if (revokedAt === null) {
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
