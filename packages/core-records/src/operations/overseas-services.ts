// SPDX-License-Identifier: AGPL-3.0-only
//
// The overseas-services register (C81, SP-25, migration 0035): one row per
// outside service that receives personal information. The privacy policy
// reads it: a policy version is drafted with the rows in use and their digest,
// and approving or publishing it checks the register still has that digest
// and holds no row to confirm (`legal-documents.ts`).
//
// The register has one lock per business, `overseas-services:<business>`,
// taken by every write here and by every draft, approval and publication of a
// privacy policy before it reads the register. A change and a policy decision
// therefore apply in one order, each seeing the other's effect.

import { createHash, randomUUID } from 'node:crypto';
import { advisoryLock, type TenantQuery } from '../tenancy/database.ts';

/** A register row as it is set. */
export interface OverseasService {
  readonly service: string;
  readonly receives: string;
  readonly where: string;
  readonly trainsOnIt: string;
  readonly contract: string;
  readonly toConfirm: boolean;
  readonly inUse: boolean;
}

/** A service as the privacy policy lists it. */
export interface ListedService {
  readonly service: string;
  readonly receives: string;
  readonly where: string;
  readonly trainsOnIt: string;
  readonly contract: string;
}

/** The rows in use, in the register's order, with what a policy checks. */
export interface RegisterState {
  readonly listed: readonly ListedService[];
  readonly digest: string;
  readonly unconfirmed: boolean;
}

/** Take the business's register lock for the rest of the transaction. */
export async function lockRegister(tx: TenantQuery): Promise<void> {
  await advisoryLock(tx, `overseas-services:${tx.businessId}`);
}

/**
 * Set one service's row, matched by its name in any letter case, under the
 * register's lock; answers the row's id.
 */
export async function setOverseasService(
  tx: TenantQuery,
  row: OverseasService,
  actorId: string,
): Promise<{ readonly id: string }> {
  await lockRegister(tx);
  const rows = await tx.query<{ readonly id: string }>(
    `insert into public.overseas_services
       (business_id, id, service, receives, stored_where, trains_on_it, contract,
        to_confirm, in_use, updated_by_actor)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (business_id, lower(service)) do update
       set service = excluded.service, receives = excluded.receives,
           stored_where = excluded.stored_where, trains_on_it = excluded.trains_on_it,
           contract = excluded.contract, to_confirm = excluded.to_confirm,
           in_use = excluded.in_use, updated_at = now(),
           updated_by_actor = excluded.updated_by_actor
     returning id`,
    [
      tx.businessId,
      randomUUID(),
      row.service,
      row.receives,
      row.where,
      row.trainsOnIt,
      row.contract,
      row.toConfirm,
      row.inUse,
      actorId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('overseas_services: the upsert returned no row');
  return { id };
}

/**
 * The rows in use and their digest. The caller holds the register's lock, so
 * no change lands between this read and the decision made on it.
 */
export async function readRegister(tx: TenantQuery): Promise<RegisterState> {
  const rows = await tx.query<{
    readonly service: string;
    readonly receives: string;
    readonly stored_where: string;
    readonly trains_on_it: string;
    readonly contract: string;
    readonly to_confirm: boolean;
  }>(
    `select service, receives, stored_where, trains_on_it, contract, to_confirm
       from public.overseas_services
      where business_id = $1 and in_use
      order by lower(service), id`,
    [tx.businessId],
  );
  const listed = rows.map((row) => ({
    service: row.service,
    receives: row.receives,
    where: row.stored_where,
    trainsOnIt: row.trains_on_it,
    contract: row.contract,
  }));
  // The digest covers each row's words and its "to confirm" mark, in order.
  const canonical = JSON.stringify(
    rows.map((row) => [
      row.service,
      row.receives,
      row.stored_where,
      row.trains_on_it,
      row.contract,
      row.to_confirm,
    ]),
  );
  return {
    listed,
    digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    unconfirmed: rows.some((row) => row.to_confirm),
  };
}
