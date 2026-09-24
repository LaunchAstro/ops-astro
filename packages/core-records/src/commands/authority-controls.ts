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
// handlers discover before any runtime lock and write only after it, and both
// answer with the ids of the holds they classified and nothing else about them.
//
// EX-01. A person's own lease carries no delegation: its work authority is the
// person's own live `write` on the task, read from their person and actor
// subjects, which is exactly what pickup, renewal and handback check. A grant
// revocation that costs a person that authority ends their lease the same way.

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
import {
  AffectedSetChanged,
  classifyAuthorityLoss,
  type Classification,
} from '../../../core-runtime/src/recovery.ts';
import type { CommandContext } from './context.ts';
import { declarationOf } from './surface.ts';
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

/**
 * The collection a person's own claim checks `write` in: `task.pickup`'s, so
 * this and pickup cannot come to disagree about which grant a claim rests on.
 */
function claimCollection(): string {
  const declared = declarationOf('task.pickup');
  if (declared === undefined) throw new Error('grant.revoke: task.pickup is not declared');
  return declared.collection;
}

/** A live attempt drawing on a person the revoked grant may have covered. */
interface Dependent {
  readonly lease_id: string;
  /** Null for a person's own lease (EX-01), which draws on that person directly. */
  readonly delegation_id: string | null;
  readonly person_id: string;
  /** The holding actor of a person's own lease, whose grants pickup also read. */
  readonly actor_id: string | null;
  readonly task_id: string;
  readonly collections: readonly string[];
}

/**
 * Read-only: the live leases whose authority the grant, or a grant derived
 * from it, may have carried. A revocation collapses what the revoked grant
 * issued (`grants.ts`), so its descendants' subjects are candidates too.
 *
 * `write` only, because that is the work authority a claim draws on: the
 * action `task.pickup`, `task.heartbeat` and `task.handback` are declared
 * under (`surface.ts`), and the one person pickup, renewal and handback each
 * re-read under their locks (T3 line 66: the person uses "the same work/lease
 * contract"). An agent's lease draws on its delegating person, because a
 * delegation's ceiling is that person's own grants (`checkDelegatedAuthority`).
 * A person's own lease draws on the holder's person and actor subjects, the
 * two `subjectsOf` gives their session. A candidate is not yet a loss: the
 * holder may have write through another grant, which is re-read under the locks.
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
     select l.id as lease_id, l.delegation_id, l.authorised_by_person_id as person_id,
            null::uuid as actor_id, l.task_id, d.collections
       from public.leases l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.business_id = $1 and l.state = 'live'
        and d.revoked_at is null and d.settled_at is null
        and exists (select 1 from revoked r
                     where r.subject_kind = 'person' and r.subject_id = l.authorised_by_person_id
                       and r.action = 'write' and r.collection = any(d.collections))
     union all
     select l.id as lease_id, null::uuid, a.person_id, l.holder_actor_id, l.task_id,
            array[$3::text]
       from public.leases l
       join public.actors a
         on a.business_id = l.business_id and a.id = l.holder_actor_id and a.kind = 'person'
      where l.business_id = $1 and l.state = 'live' and l.delegation_id is null
        and exists (select 1 from revoked r
                     where r.action = 'write' and r.collection = $3
                       and ((r.subject_kind = 'person' and r.subject_id = a.person_id)
                            or (r.subject_kind = 'actor' and r.subject_id = l.holder_actor_id)))
      order by lease_id`,
    [tx.businessId, grantId, claimCollection()],
  );
}

/** Whether the attempt's holder of authority still holds write on its task, in every collection. */
async function stillAuthorised(tx: TenantQuery, dependent: Dependent): Promise<boolean> {
  const subjects = [
    { kind: 'person' as const, id: dependent.person_id },
    ...(dependent.actor_id === null ? [] : [{ kind: 'actor' as const, id: dependent.actor_id }]),
  ];
  for (const collection of dependent.collections) {
    // eslint-disable-next-line no-await-in-loop -- one collection per delegation today
    const held = await checkAuthority(tx, subjects, {
      collection,
      action: 'write',
      scope: { kind: 'record', id: dependent.task_id },
    });
    if (!held.ok) return false;
  }
  return true;
}

/**
 * The holds a loss classified, by id only: the response says which work it
 * ended and nothing about whose. One the classifier left held is not listed.
 */
const classifiedHolds = (classified: readonly Classification[]): readonly string[] =>
  classified.filter((each) => each.state !== 'held').map((each) => each.reservationId);

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
    // F4. Locked before the runtime set, outside the global order on purpose:
    // `grants` is not a class in it. The one runtime operation that locks a
    // grant row is `task.pickup`, which holds `for share` on its covering
    // grants (`holdCoveringGrants`) before its own runtime locks, the same
    // order as here. So no transaction waits on a grant row while holding
    // runtime locks, and no cycle can close through it. Two revocations of
    // one grant serialise here, and a pickup and a revocation serialise on the
    // grant row, before either has discovered or locked any work.
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
    delegationIds: candidates.flatMap((each) =>
      each.delegation_id === null ? [] : [each.delegation_id],
    ),
    personLeases: {
      leaseIds: candidates.flatMap((each) => (each.delegation_id === null ? [each.lease_id] : [])),
      causeId: grantId,
    },
    revoke: async () => {
      // The candidate set is part of the lock set, so it is rechecked like
      // the rest of it: a pickup that committed in between is a lease these
      // locks do not cover.
      const current = await dependents(tx, grantId);
      if (JSON.stringify(current) !== JSON.stringify(candidates)) {
        throw new AffectedSetChanged(
          'grant.revoke: the dependent attempts changed under discovery; roll back and rediscover rather than extending the lock set',
        );
      }
      const revokedAt = await revokeGrant(tx, grantId);
      if (revokedAt === null) return { applied: false, value: null };
      // Re-evaluated after the revocation and under the locks: only an
      // attempt whose person now holds no write on its task has lost its
      // work authority. One still covered by another live grant is untouched.
      const lost: string[] = [];
      const lostLeases: string[] = [];
      for (const dependent of current) {
        // eslint-disable-next-line no-await-in-loop -- one per live attempt, each decisive
        if (await stillAuthorised(tx, dependent)) continue;
        if (dependent.delegation_id === null) lostLeases.push(dependent.lease_id);
        else lost.push(dependent.delegation_id);
      }
      return { applied: true, value: revokedAt, lost, lostLeases };
    },
  });
  if (!loss.applied || loss.value === null) return already;
  return applied(grantId, null, {
    grantId,
    revokedAt: loss.value.toISOString(),
    classifiedHolds: classifiedHolds(loss.classified),
  });
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
      const revokedAt =
        live[0]?.live === true
          ? await revokeDelegation(tx, delegationId, 'delegation_revoked')
          : null;
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
  return applied(delegationId, null, {
    delegationId,
    revokedAt: revokedAt.toISOString(),
    classifiedHolds: classifiedHolds(loss.classified),
  });
}
