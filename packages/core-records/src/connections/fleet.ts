// SPDX-License-Identifier: AGPL-3.0-only
//
// The connector fleet (MP-14-7a): the connections a caller may read, and the
// start of a repair.
//
// `listConnections` filters by the scopes the caller holds `connection:read`
// at inside its one statement: a business-wide holder sees every connection
// and every client in it; a client-scoped holder sees only the connections
// that serve one of their clients, and only those clients in each list. Every
// join is on the business as well as the id, beside the tenancy policy. A
// client's label is its name in `clients`. The credential is a reference: the
// secret's id and whether custody holds a value for it, never a column that
// could carry one (20261003001523 refuses those to the application role in
// any case). The reference is shown to a business-wide reader, for a
// business-wide secret, or for one scoped to one of the caller's clients. A
// client-scoped `connection:read` reader therefore sees a business-wide
// secret's reference, by design, though `listSecrets` would not list that
// secret to them. A secret scoped to another client the same connection
// serves shows as no secret, not set.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import type { Scope } from '../authority/grants.ts';

export type ConnectionStatus = 'active' | 'degraded' | 'broken';

export interface ConnectionClient {
  readonly id: string;
  readonly label: string;
}

export interface ConnectionRow {
  readonly id: string;
  readonly connectorKey: string;
  readonly label: string;
  readonly authMethod: string;
  readonly status: ConnectionStatus;
  readonly failureClass: string | null;
  readonly cadenceMinutes: number;
  readonly lastSyncedAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly scope: string;
  readonly readComponents: readonly string[];
  readonly executeComponents: readonly string[];
  readonly secretId: string | null;
  readonly secretSet: boolean;
  readonly clients: readonly ConnectionClient[];
  /** When a repair was started on this revision, if one was. */
  readonly repairStartedAt: Date | null;
  readonly revision: number;
}

interface Row {
  readonly id: string;
  readonly connector_key: string;
  readonly label: string;
  readonly auth_method: string;
  readonly status: ConnectionStatus;
  readonly failure_class: string | null;
  readonly cadence_minutes: number;
  readonly last_synced_at: Date | null;
  readonly last_attempt_at: Date | null;
  readonly scope: string;
  readonly read_components: readonly string[];
  readonly execute_components: readonly string[];
  readonly secret_id: string | null;
  readonly secret_set: boolean;
  readonly clients: readonly ConnectionClient[];
  readonly repair_started_at: Date | null;
  readonly revision: string;
}

/** The connections these scopes may read, each with its clients filtered alike. */
export async function listConnections(
  tx: TenantQuery,
  scopes: readonly Scope[],
): Promise<readonly ConnectionRow[]> {
  const whole = scopes.some((scope) => scope.kind === 'business');
  const parties = scopes.filter((scope) => scope.kind === 'party').map((scope) => scope.id);
  const rows = await tx.query<Row>(
    `select c.id, c.connector_key, c.label, c.auth_method, c.status, c.failure_class,
            c.cadence_minutes, c.last_synced_at, c.last_attempt_at, c.scope, c.read_components,
            c.execute_components, s.id as secret_id, s.set_at is not null as secret_set,
            r.started_at as repair_started_at, c.revision,
            coalesce((select json_agg(json_build_object('id', k.id, 'label', k.name)
                                      order by k.name, k.id)
                        from public.connection_clients cc
                        join public.clients k on k.business_id = cc.business_id and k.id = cc.client_id
                       where cc.business_id = c.business_id and cc.connection_id = c.id
                         and ($1::boolean or cc.client_id = any($2::uuid[]))), '[]'::json) as clients
       from public.connections c
       left join public.custody_secrets s on s.business_id = c.business_id and s.id = c.secret_id
        and ($1::boolean or s.scope_kind = 'business' or s.scope_id = any($2::uuid[]))
       left join public.connection_repairs r
         on r.business_id = c.business_id and r.connection_id = c.id
        and r.connection_revision = c.revision
      where $1::boolean
         or exists (select 1 from public.connection_clients cc
                     where cc.business_id = c.business_id and cc.connection_id = c.id
                       and cc.client_id = any($2::uuid[]))
      order by c.label, c.id`,
    [whole, parties],
  );
  return rows.map((row) => ({
    id: row.id,
    connectorKey: row.connector_key,
    label: row.label,
    authMethod: row.auth_method,
    status: row.status,
    failureClass: row.failure_class,
    cadenceMinutes: row.cadence_minutes,
    lastSyncedAt: row.last_synced_at,
    lastAttemptAt: row.last_attempt_at,
    scope: row.scope,
    readComponents: row.read_components,
    executeComponents: row.execute_components,
    secretId: row.secret_id,
    secretSet: row.secret_set,
    clients: row.clients,
    repairStartedAt: row.repair_started_at,
    revision: Number(row.revision),
  }));
}

export interface RepairStarted {
  readonly id: string;
  readonly connectionId: string;
  readonly connectionRevision: number;
  readonly startedAt: Date;
}

export type RepairRefusal =
  | { readonly refused: 'not-found' }
  | { readonly refused: 'not-broken'; readonly status: ConnectionStatus }
  | { readonly refused: 'stale'; readonly revision: number };

/** The connection's status and revision now, looked up as this business's own. */
async function connectionNow(
  tx: TenantQuery,
  id: string,
): Promise<{ readonly status: ConnectionStatus; readonly revision: string } | undefined> {
  const found = await tx.query<{ readonly status: ConnectionStatus; readonly revision: string }>(
    `select status, revision from public.connections
      where business_id = (select public.app_business_id()) and id = $1`,
    [id],
  );
  return found[0];
}

/**
 * Record `connector repair started` on a broken connection, at the revision
 * it is at now. It sends nothing and changes nothing on the connection:
 * re-authorising is the broker's, behind the approval gate on this revision.
 * The connection is looked up as this business's own, by its owner column as
 * well as the tenancy policy, so another business's id is not found.
 *
 * No row lock: the application role may not update `connections`, so it
 * cannot take one. The insert checks again, in its own statement, that the
 * connection is still broken at the revision read; if it healed or moved on
 * in between, nothing is inserted and the start is refused as the first
 * checks would refuse it now. Two starters on one revision serialise on the
 * unique key (connection, revision): the second insert waits for the first
 * to commit, does nothing, and both answer with the one repair.
 */
export async function startRepair(
  tx: TenantQuery,
  start: {
    readonly connectionId: string;
    readonly actorId: string;
    readonly expectedRevision?: number;
  },
): Promise<RepairStarted | RepairRefusal> {
  const connection = await connectionNow(tx, start.connectionId);
  if (connection === undefined) return { refused: 'not-found' };
  const revision = Number(connection.revision);
  if (start.expectedRevision !== undefined && start.expectedRevision !== revision) {
    return { refused: 'stale', revision };
  }
  if (connection.status !== 'broken') return { refused: 'not-broken', status: connection.status };
  await tx.query(
    `insert into public.connection_repairs
       (business_id, id, connection_id, connection_revision, started_by_actor_id)
     select (select public.app_business_id()), $1::uuid, $2::uuid, $3::bigint, $4::uuid
      where exists (select 1 from public.connections
                     where business_id = (select public.app_business_id()) and id = $2::uuid
                       and revision = $3::bigint and status = 'broken')
     on conflict (business_id, connection_id, connection_revision) do nothing`,
    [randomUUID(), start.connectionId, revision, start.actorId],
  );
  const rows = await tx.query<{ readonly id: string; readonly started_at: Date }>(
    `select id, started_at from public.connection_repairs
      where business_id = (select public.app_business_id())
        and connection_id = $1 and connection_revision = $2`,
    [start.connectionId, revision],
  );
  const row = rows[0];
  if (row === undefined) {
    // Healed or moved on since the read: refuse as the checks above would now.
    const moved = await connectionNow(tx, start.connectionId);
    if (moved === undefined) return { refused: 'not-found' };
    if (moved.status !== 'broken') return { refused: 'not-broken', status: moved.status };
    return { refused: 'stale', revision: Number(moved.revision) };
  }
  return {
    id: row.id,
    connectionId: start.connectionId,
    connectionRevision: revision,
    startedAt: row.started_at,
  };
}

export function isRepairRefusal(value: object): value is RepairRefusal {
  return 'refused' in value;
}
