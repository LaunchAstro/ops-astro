// SPDX-License-Identifier: AGPL-3.0-only
//
// Grants given and revoked on Settings ▸ Access (C32, CS-2.15), the tracked
// action `grant changed` under `access:manage`.
//
// A grant given here is a root grant: `access:manage` is the owner's and the
// administrators' key, the administrative path `issueGrant` names. It is given
// to a person with an active membership of this business, over the whole
// business or over one client of it, and the key is checked against the
// catalogue by the command before it arrives.
//
// Every change takes the business's one access lock first
// (`access:<business>`), so two changes never judge the same grants at once:
// the same grant given twice is one row, and two revocations that would each
// leave one holder of `access:manage` cannot both apply. Ending a person's
// access (C58) takes the same lock.

import { refuseCommand, type CommandRefusal } from '../register.ts';
import { advisoryLock, type TenantQuery } from '../tenancy/database.ts';
import { isClientHere, type AccessDecision } from '../clients/clients.ts';
import { EFFECTIVE, issueGrant, type Action } from './grants.ts';

export interface AccessGrant {
  readonly personId: string;
  readonly collection: string;
  readonly action: Action;
  /** A client of this business, or null for the whole business. */
  readonly clientId: string | null;
}

/** The business's one lock for a change to who may do what. */
export async function lockAccess(tx: TenantQuery): Promise<void> {
  await advisoryLock(tx, `access:${tx.businessId}`);
}

/**
 * Give a person a grant, or answer the live root grant they already hold of
 * exactly that key and scope. A person or client not of this business is
 * `NOT_FOUND`, the same answer as a made-up id.
 */
export async function grantAccess(
  tx: TenantQuery,
  grant: AccessGrant,
  actorId: string,
): Promise<AccessDecision<string>> {
  await lockAccess(tx);
  const member = await tx.query<{ readonly id: string }>(
    `select p.id from public.people p
       join public.memberships m
         on m.business_id = p.business_id and m.person_id = p.id and m.active
      where p.business_id = $1 and p.id = $2::uuid`,
    [tx.businessId, grant.personId],
  );
  if (member.length === 0) {
    return notFound(
      'holderId',
      'No person of this business with an active membership carries that identifier.',
    );
  }
  if (grant.clientId !== null && !(await isClientHere(tx, grant.clientId))) {
    return notFound('clientId', 'No client of this business carries that identifier.');
  }
  const scope =
    grant.clientId === null
      ? { kind: 'business' as const, id: null }
      : { kind: 'party' as const, id: grant.clientId };
  const held = await tx.query<{ readonly id: string }>(
    `select id from public.grants
      where business_id = $1 and subject_kind = 'person' and subject_id = $2::uuid
        and collection = $3 and action = $4 and scope_kind = $5
        and scope_id is not distinct from $6::uuid
        and parent_grant_id is null and revoked_at is null and expires_at is null
      order by granted_at, id limit 1`,
    [tx.businessId, grant.personId, grant.collection, grant.action, scope.kind, scope.id],
  );
  const already = held[0];
  if (already !== undefined) return { ok: true, value: already.id };
  return await issueGrant(tx, [], {
    subject: { kind: 'person', id: grant.personId },
    scope,
    collection: grant.collection,
    action: grant.action,
    parentGrantId: null,
    grantedByActorId: actorId,
  });
}

/**
 * How many people who can sign in hold business-wide `access:manage` by a
 * live grant other than the ones named. Asked under the access lock.
 */
export async function otherManagers(
  tx: TenantQuery,
  leaving: readonly string[],
  leavingPersonId: string | null = null,
): Promise<number> {
  const rows = await tx.query<{ readonly n: number }>(
    `${EFFECTIVE}
     select count(distinct coalesce(a.person_id, e.subject_id))::int as n
       from effective e
       left join public.actors a
         on e.subject_kind = 'actor' and a.business_id = e.business_id and a.id = e.subject_id
       join public.memberships m
         on m.business_id = e.business_id and m.active
        and m.person_id = coalesce(a.person_id, e.subject_id)
      where e.business_id = $1
        and e.collection = 'access' and e.action = 'manage' and e.scope_kind = 'business'
        and (e.subject_kind = 'person' or a.person_id is not null)
        and not (e.id = any($2::uuid[]))
        and coalesce(a.person_id, e.subject_id) is distinct from $3::uuid`,
    [tx.businessId, leaving, leavingPersonId],
  );
  return rows[0]?.n ?? 0;
}

export function lastManager(): CommandRefusal {
  return refuseCommand(
    'ACCESS_LAST_MANAGER',
    [],
    [
      'It would leave nobody in this business who can change access.',
      'Give another person access:manage over the whole business first.',
    ],
  );
}

function notFound(name: string, reason: string): AccessDecision<never> {
  return {
    ok: false,
    refusal: refuseCommand('NOT_FOUND', [name], [reason, 'Read access.read for what is here.']),
  };
}
