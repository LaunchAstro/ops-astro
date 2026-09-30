// SPDX-License-Identifier: AGPL-3.0-only
//
// The custody rows (C31): set, clear, list and mark used.
//
// Nothing here returns a value. `setSecret` takes one and seals it before the
// statement is built, so the plaintext never becomes a bound parameter, a log
// line or a row. `listSecrets` selects only the columns the application role
// is granted (migration 0042), and a statement that named a sealed column
// would be refused by the server.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import type { Scope } from '../authority/grants.ts';
import { seal, type SealingKey } from './sealing.ts';

/** A secret's scope: the business, or one client (a party). */
export type SecretScope =
  | { readonly kind: 'business'; readonly id: null }
  | { readonly kind: 'party'; readonly id: string };

export interface SecretRow {
  readonly id: string;
  readonly name: string;
  readonly scope: SecretScope;
  readonly isSet: boolean;
  readonly setAt: Date | null;
  readonly clearedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly revision: number;
}

export interface SecretWritten {
  readonly id: string;
  readonly revision: number;
}

/** The row has moved past the revision the caller read. */
export interface SecretStale {
  readonly stale: true;
  readonly revision: number;
}

interface Row {
  readonly id: string;
  readonly name: string;
  readonly scope_kind: 'business' | 'party';
  readonly scope_id: string | null;
  readonly set_at: Date | null;
  readonly cleared_at: Date | null;
  readonly last_used_at: Date | null;
  readonly revision: string;
}

const COLUMNS = 'id, name, scope_kind, scope_id, set_at, cleared_at, last_used_at, revision';

function toRow(row: Row): SecretRow {
  return {
    id: row.id,
    name: row.name,
    scope:
      row.scope_kind === 'business' || row.scope_id === null
        ? { kind: 'business', id: null }
        : { kind: 'party', id: row.scope_id },
    isSet: row.set_at !== null,
    setAt: row.set_at,
    clearedAt: row.cleared_at,
    lastUsedAt: row.last_used_at,
    revision: Number(row.revision),
  };
}

/** The row by id, locked for the write that follows. */
async function lockSecret(tx: TenantQuery, id: string): Promise<Row | undefined> {
  const rows = await tx.query<Row>(
    `select ${COLUMNS} from public.custody_secrets where id = $1 for update`,
    [id],
  );
  return rows[0];
}

/** The row by name and scope, locked, if one exists. */
async function lockByName(
  tx: TenantQuery,
  name: string,
  scope: SecretScope,
): Promise<Row | undefined> {
  const rows = await tx.query<Row>(
    `select ${COLUMNS} from public.custody_secrets
      where name = $1 and scope_kind = $2 and scope_id is not distinct from $3::uuid
      for update`,
    [name, scope.kind, scope.id],
  );
  return rows[0];
}

/** One secret, without locking, for a check before a write. */
export async function readSecret(tx: TenantQuery, id: string): Promise<SecretRow | undefined> {
  const rows = await tx.query<Row>(`select ${COLUMNS} from public.custody_secrets where id = $1`, [
    id,
  ]);
  const row = rows[0];
  return row === undefined ? undefined : toRow(row);
}

/**
 * Seal `value` and store it under `name` at `scope`, replacing any value there.
 *
 * Two setters of one name serialise on the row lock, or on the unique index
 * when neither row exists yet: the loser of that insert race waits, then
 * updates the winner's row. Setting again leaves `last_used_at` where it was:
 * a new value has not been used.
 */
export async function setSecret(
  tx: TenantQuery,
  write: {
    readonly name: string;
    readonly scope: SecretScope;
    readonly value: string;
    readonly key: SealingKey;
    readonly actorId: string;
    readonly expectedRevision?: number;
  },
): Promise<SecretWritten | SecretStale> {
  const sealed = seal(write.value, write.key);
  const existing = await lockByName(tx, write.name, write.scope);
  if (
    existing !== undefined &&
    write.expectedRevision !== undefined &&
    Number(existing.revision) !== write.expectedRevision
  ) {
    return { stale: true, revision: Number(existing.revision) };
  }
  const rows = await tx.query<{ readonly id: string; readonly revision: string }>(
    `insert into public.custody_secrets
       (business_id, id, name, scope_kind, scope_id, sealed, ephemeral_public, nonce, key_id,
        set_at, set_by_actor_id)
     values ((select public.app_business_id()), $1, $2, $3, $4::uuid, $5, $6, $7, $8, now(), $9)
     -- Parameters, not excluded.*: reading an excluded sealed column needs
     -- the select privilege the application role is refused (0042).
     on conflict (business_id, name, scope_kind, scope_id) do update
       set sealed = $5, ephemeral_public = $6, nonce = $7, key_id = $8, set_at = now(),
           set_by_actor_id = $9,
           cleared_at = null,
           cleared_by_actor_id = null,
           revision = public.custody_secrets.revision + 1
     returning id, revision`,
    [
      randomUUID(),
      write.name,
      write.scope.kind,
      write.scope.id,
      sealed.sealed,
      sealed.ephemeralPublic,
      sealed.nonce,
      sealed.keyId,
      write.actorId,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('setSecret: the upsert returned no row');
  return { id: row.id, revision: Number(row.revision) };
}

/**
 * Clear a secret's value, keeping its row and history. Undefined when there is
 * no such row in this business. Clearing an already clear secret still moves
 * the revision and records who cleared it.
 */
export async function clearSecret(
  tx: TenantQuery,
  clear: { readonly id: string; readonly actorId: string; readonly expectedRevision?: number },
): Promise<SecretWritten | SecretStale | undefined> {
  const existing = await lockSecret(tx, clear.id);
  if (existing === undefined) return undefined;
  if (
    clear.expectedRevision !== undefined &&
    Number(existing.revision) !== clear.expectedRevision
  ) {
    return { stale: true, revision: Number(existing.revision) };
  }
  const rows = await tx.query<{ readonly id: string; readonly revision: string }>(
    `update public.custody_secrets
        set sealed = null, ephemeral_public = null, nonce = null, key_id = null, set_at = null,
            cleared_at = now(), cleared_by_actor_id = $2, revision = revision + 1
      where id = $1
      returning id, revision`,
    [clear.id, clear.actorId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('clearSecret: the locked row vanished');
  return { id: row.id, revision: Number(row.revision) };
}

/**
 * The secrets at the scopes the caller holds. A business-wide scope sees every
 * row; a party scope sees that party's rows only. The filter is in the
 * statement, so a row outside it is never read, counted or ordered.
 */
export async function listSecrets(
  tx: TenantQuery,
  scopes: readonly Scope[],
): Promise<readonly SecretRow[]> {
  const whole = scopes.some((scope) => scope.kind === 'business');
  const parties = scopes.filter((scope) => scope.kind === 'party').map((scope) => scope.id);
  const rows = await tx.query<Row>(
    `select ${COLUMNS} from public.custody_secrets
      where $1::boolean or (scope_kind = 'party' and scope_id = any($2::uuid[]))
      order by name, scope_kind, scope_id nulls first`,
    [whole, parties],
  );
  return rows.map((row) => toRow(row));
}

/**
 * The broker's use of a set secret moves its last-used time. Called by the
 * dispatch that injected it (AW-01); a clear secret cannot be used, so it
 * answers false and moves nothing.
 */
export async function markSecretUsed(tx: TenantQuery, id: string): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    `update public.custody_secrets set last_used_at = now()
      where id = $1 and set_at is not null
      returning id`,
    [id],
  );
  return rows.length === 1;
}

export function isSecretStale(value: object): value is SecretStale {
  return 'stale' in value;
}
