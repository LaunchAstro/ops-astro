// SPDX-License-Identifier: AGPL-3.0-only
//
// The people a task may be assigned to.
//
// "Active membership" is the whole of it, and it is the same condition
// `resolveLogin` uses to decide whether a caller may act at all. That is
// deliberate: the assignee choices a screen offers and the people the server
// will accept an assignment to have to be one list, or the screen offers a
// choice the server then refuses.
//
// Nothing here crosses a business. The query is scoped by the business the
// session set and row security holds the same line underneath it, so a person
// of another business is not filtered out -- they are not visible to filter.

import {
  heldPermissions,
  listAllClients,
  standsOnShares,
} from '../../../core-records/src/index.ts';
import type { HeldPermission, TenantQuery } from '../../../core-records/src/index.ts';
import type {
  AccessAgent,
  AccessPermission,
  AccessPerson,
  AccessReadResult,
} from '../../../core-wire/src/index.ts';
import type { PersonView } from './requests.ts';

export async function listPeople(tx: TenantQuery): Promise<readonly PersonView[]> {
  const rows = await tx.query<{ readonly id: string; readonly display_name: string }>(
    `select p.id, p.display_name
       from public.people p
       join public.memberships m
         on m.business_id = p.business_id and m.person_id = p.id and m.active
      where p.business_id = $1
      order by p.display_name`,
    [tx.businessId],
  );
  return rows.map((row) => ({ personId: row.id, name: row.display_name }));
}

interface DelegationRow {
  readonly id: string;
  readonly agent_actor_id: string;
  readonly person_id: string;
  readonly display_name: string;
  readonly purpose: string;
  readonly collections: readonly string[];
  readonly actions: readonly string[];
  readonly purpose_scope_kind: 'record';
  readonly purpose_scope_id: string;
  readonly expires_at: Date;
}

/**
 * Settings ▸ Access (C32): Team, Clients and Agents, each with what it may do
 * now. One list of people underneath all three (RC-22). Team is `listPeople`
 * itself, not a copy of its query. Clients are the people with no active
 * membership who stand on a share, by `standsOnShares`, the rule sign-in
 * asks. A former member whose grant outlived them is on neither list: sign-in
 * refuses them, so they can do nothing now. An agent carries its person's row.
 *
 * Each preview is `heldPermissions`, the grant check's own walk, for a person
 * sign-in would admit: one with standing and an active acting identity. The
 * grant check runs only behind sign-in, so a person it refuses (for instance
 * `ACTOR_INACTIVE`) is shown no permission. It cannot say more than the check
 * grants.
 */
export async function readAccess(tx: TenantQuery): Promise<Omit<AccessReadResult, 'ok'>> {
  const team = await listPeople(tx);
  const held = await heldPermissions(tx);
  const members = new Set(team.map((person) => person.personId));
  const outside: string[] = [];
  for (const personId of new Set(held.map((permission) => permission.personId))) {
    // oxlint-disable-next-line no-await-in-loop
    if (!members.has(personId) && (await standsOnShares(tx, personId))) outside.push(personId);
  }
  const acting = await tx.query<{ readonly person_id: string }>(
    `select person_id from public.actors where business_id = $1 and kind = 'person' and active`,
    [tx.businessId],
  );
  const admitted = new Set(acting.map((row) => row.person_id));
  const clients = await tx.query<{ readonly id: string; readonly display_name: string }>(
    `select id, display_name from public.people
      where business_id = $1 and id = any($2::uuid[])
      order by display_name, id`,
    [tx.businessId, outside],
  );
  const delegations = await tx.query<DelegationRow>(
    `select d.id, d.agent_actor_id, p.id as person_id, p.display_name, d.purpose, d.collections,
            d.actions, d.purpose_scope_kind, d.purpose_scope_id, d.expires_at
       from public.delegations d
       join public.actors a
         on a.business_id = d.business_id and a.id = d.agent_actor_id and a.active
       join public.people p
         on p.business_id = d.business_id and p.id = d.delegate_person_id
      where d.business_id = $1
        and d.revoked_at is null and d.settled_at is null and d.expires_at > now()
      order by d.granted_at, d.id`,
    [tx.businessId],
  );
  const withPreview = (person: PersonView): AccessPerson => ({
    ...person,
    permissions: admitted.has(person.personId)
      ? once(held.filter((permission) => permission.personId === person.personId))
      : [],
    grants: [],
  });
  return {
    team: team.map((person) => withPreview(person)),
    clients: clients.map((row) => withPreview({ personId: row.id, name: row.display_name })),
    agents: delegations.map((row) => agentOf(row, held)),
    clientRecords: await listAllClients(tx),
  };
}

/** Each permission once, whether the grant names the person or their acting identity. */
function once(held: readonly AccessPermission[]): AccessPermission[] {
  const kept = new Map<string, AccessPermission>();
  for (const { collection, action, scope } of held) {
    kept.set(`${collection}:${action}:${scope.kind}:${scope.id}`, { collection, action, scope });
  }
  return [...kept.values()];
}

/**
 * What `checkDelegatedAuthority` grants the agent: each collection and action
 * its purpose carries, except `decide`, that its person holds by a grant
 * naming them, at business scope or on the delegation's one record; and only
 * ever on that record.
 */
function agentOf(row: DelegationRow, held: readonly HeldPermission[]): AccessAgent {
  const scope = { kind: row.purpose_scope_kind, id: row.purpose_scope_id };
  const drawn = held.filter(
    (permission) =>
      permission.personId === row.person_id &&
      permission.direct &&
      permission.action !== 'decide' &&
      row.collections.includes(permission.collection) &&
      row.actions.includes(permission.action) &&
      (permission.scope.kind === 'business' ||
        (permission.scope.kind === scope.kind && permission.scope.id === scope.id)),
  );
  return {
    agentActorId: row.agent_actor_id,
    delegationId: row.id,
    purpose: row.purpose,
    person: { personId: row.person_id, name: row.display_name },
    expiresAt: row.expires_at.toISOString(),
    permissions: once(drawn.map(({ collection, action }) => ({ collection, action, scope }))),
  };
}
