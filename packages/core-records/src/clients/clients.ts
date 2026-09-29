// SPDX-License-Identifier: AGPL-3.0-only
//
// The client record (C32, CS-2.15; migration 0036). A client is an
// organisation the business works for: the party a party-scoped grant names
// and a task's `client` link points at. It is written once by `client.create`
// and never deleted.
//
// Who may see which client is the grants' answer, asked inside the query: a
// caller with any live grant over the whole business sees every client, and a
// caller whose grants reach only some clients sees those and no count or
// trace of the rest.

import { refuseCommand, type CommandRefusal } from '../register.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { EFFECTIVE, type Subject } from '../authority/grants.ts';

/** Returned, never thrown: the value, or the register's one refusal. */
export type AccessDecision<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: CommandRefusal };

export interface ClientRow {
  readonly clientId: string;
  readonly name: string;
}

/** The longest name the table holds (`clients_name_present`). */
export const CLIENT_NAME_MOST = 200;

/**
 * Make a client of this business. The name is checked by the caller; one
 * already taken in any letter case is refused by name, and the insert waits
 * on nothing: the unique index is the one judge of a race between two.
 */
export async function createClient(
  tx: TenantQuery,
  name: string,
  actorId: string,
): Promise<AccessDecision<string>> {
  const rows = await tx.query<{ readonly id: string }>(
    `insert into public.clients (business_id, id, name, created_by_actor_id)
     values ($1, gen_random_uuid(), $2, $3)
     on conflict (business_id, lower(name)) do nothing
     returning id`,
    [tx.businessId, name, actorId],
  );
  const made = rows[0];
  if (made === undefined) {
    return {
      ok: false,
      refusal: refuseCommand(
        'CLIENT_NAME_TAKEN',
        ['name'],
        [
          'This business already has a client of that name.',
          'Read client.list, or choose another name.',
        ],
      ),
    };
  }
  return { ok: true, value: made.id };
}

/** Every client of this business, for a holder of `access:manage`. */
export async function listAllClients(tx: TenantQuery): Promise<readonly ClientRow[]> {
  return await tx.query<ClientRow>(
    `select id as "clientId", name from public.clients
      where business_id = $1 order by lower(name), id`,
    [tx.businessId],
  );
}

/**
 * The clients these subjects' live grants reach, or null when they hold no
 * live grant at all (an answer the read refuses, since empty and denied are
 * different answers). The grant rows are walked by `EFFECTIVE`, the grant
 * check's own expression, so a revoked or expired grant, or one cut from a
 * revoked parent, reaches nothing.
 */
export async function clientsReached(
  tx: TenantQuery,
  subjects: readonly Subject[],
): Promise<readonly ClientRow[] | null> {
  const rows = await tx.query<{
    readonly held: boolean;
    readonly client_id: string | null;
    readonly name: string | null;
  }>(
    `${EFFECTIVE},
     mine as (
       select e.scope_kind, e.scope_id from effective e
        where e.business_id = $1
          and exists (select 1 from unnest($2::text[], $3::uuid[]) as s (kind, id)
                       where s.kind = e.subject_kind and s.id = e.subject_id)
     )
     select exists (select 1 from mine) as held, c.id as client_id, c.name
       from (select 1) as one
       left join public.clients c
         on c.business_id = $1
        and exists (select 1 from mine m
                     where m.scope_kind = 'business'
                        or (m.scope_kind = 'party' and m.scope_id = c.id))
      order by lower(c.name), c.id`,
    [tx.businessId, subjects.map((subject) => subject.kind), subjects.map((subject) => subject.id)],
  );
  if (rows[0]?.held !== true) return null;
  return rows.flatMap((row) =>
    row.client_id === null || row.name === null
      ? []
      : [{ clientId: row.client_id, name: row.name }],
  );
}

/** Whether an id names a client of this business; another business's is not one. */
export async function isClientHere(tx: TenantQuery, clientId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    'select id from public.clients where business_id = $1 and id = $2::uuid',
    [tx.businessId, clientId],
  );
  return rows.length === 1;
}
