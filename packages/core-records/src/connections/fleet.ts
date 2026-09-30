// SPDX-License-Identifier: AGPL-3.0-only
//
// The connector fleet (MP-14-7a): the connections a caller may read, and the
// start of a repair.
//
// `listConnections` filters by the scopes the caller holds `connection:read`
// at inside its one statement: a business-wide holder sees every connection
// and every client in it; a client-scoped holder sees only the connections
// that serve one of their clients, and only those clients in each list. The
// credential is a reference: the secret's id and whether custody holds a
// value for it, never a column that could carry one (0042 refuses those to
// the application role in any case).

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
            c.cadence_minutes, c.last_synced_at, c.last_attempt_at, c.scope,
            c.read_components, c.execute_components, c.secret_id,
            coalesce(s.set_at is not null, false) as secret_set,
            r.started_at as repair_started_at, c.revision,
            coalesce((select json_agg(json_build_object('id', cc.client_id, 'label', cc.client_label)
                                      order by cc.client_label, cc.client_id)
                        from public.connection_clients cc
                       where cc.connection_id = c.id
                         and ($1::boolean or cc.client_id = any($2::uuid[]))), '[]'::json) as clients
       from public.connections c
       left join public.custody_secrets s on s.id = c.secret_id
       left join public.connection_repairs r
         on r.connection_id = c.id and r.connection_revision = c.revision
      where $1::boolean
         or exists (select 1 from public.connection_clients cc
                     where cc.connection_id = c.id and cc.client_id = any($2::uuid[]))
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

/**
 * Record `connector repair started` on a broken connection, at the revision
 * it is at now. It sends nothing and changes nothing on the connection:
 * re-authorising is the broker's, behind the approval gate on this revision.
 *
 * No row lock: the application role may not update `connections`, so it
 * cannot take one. Two starters on one revision serialise on the unique key
 * (connection, revision) instead: the second insert waits for the first to
 * commit, does nothing, and both answer with the one repair.
 */
export async function startRepair(
  tx: TenantQuery,
  start: {
    readonly connectionId: string;
    readonly actorId: string;
    readonly expectedRevision?: number;
  },
): Promise<RepairStarted | RepairRefusal> {
  const found = await tx.query<{ readonly status: ConnectionStatus; readonly revision: string }>(
    `select status, revision from public.connections where id = $1`,
    [start.connectionId],
  );
  const connection = found[0];
  if (connection === undefined) return { refused: 'not-found' };
  const revision = Number(connection.revision);
  if (start.expectedRevision !== undefined && start.expectedRevision !== revision) {
    return { refused: 'stale', revision };
  }
  if (connection.status !== 'broken') return { refused: 'not-broken', status: connection.status };
  await tx.query(
    `insert into public.connection_repairs
       (business_id, id, connection_id, connection_revision, started_by_actor_id)
     values ((select public.app_business_id()), $1, $2, $3, $4)
     on conflict (business_id, connection_id, connection_revision) do nothing`,
    [randomUUID(), start.connectionId, revision, start.actorId],
  );
  const rows = await tx.query<{ readonly id: string; readonly started_at: Date }>(
    `select id, started_at from public.connection_repairs
      where connection_id = $1 and connection_revision = $2`,
    [start.connectionId, revision],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('startRepair: the repair row is not there after insert');
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
