// SPDX-License-Identifier: AGPL-3.0-only
//
// The data-class register (C81, migration 0054): one row per class of personal
// information, with its purpose, normal disclosures, retention and deletion.
// The privacy policy reads it: a policy version is drafted with the classes in
// use and their digest, and approving or publishing it checks the classes
// still have that digest (`legal-documents.ts`). C62's retention table and the
// privacy-request workflows (C61-R) read the same rows through
// `readDataClasses`.
//
// The register shares the overseas-services register's lock
// (`overseas-services.ts`): every write here takes it, as does every draft,
// approval and publication of a privacy policy before it reads either
// register, so a change and a policy decision apply in one order.

import { createHash, randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { lockRegister } from './overseas-services.ts';

/** A class of personal information as it is set. */
export interface DataClass {
  readonly dataClass: string;
  readonly purpose: string;
  readonly disclosures: string;
  readonly retention: string;
  readonly deletion: string;
  readonly inUse: boolean;
}

/** A class as the privacy policy lists it. */
export type ListedDataClass = Omit<DataClass, 'inUse'>;

/** The classes in use, in the register's order, and their digest. */
export interface DataClassesState {
  readonly listed: readonly ListedDataClass[];
  readonly digest: string;
}

/**
 * Set one class's row, matched by its name in any letter case, under the
 * register's lock; answers the row's id.
 */
export async function setDataClass(
  tx: TenantQuery,
  row: DataClass,
  actorId: string,
): Promise<{ readonly id: string }> {
  await lockRegister(tx);
  const rows = await tx.query<{ readonly id: string }>(
    `insert into public.data_classes
       (business_id, id, data_class, purpose, disclosures, retention, deletion, in_use,
        updated_by_actor)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (business_id, lower(data_class)) do update
       set data_class = excluded.data_class, purpose = excluded.purpose,
           disclosures = excluded.disclosures, retention = excluded.retention,
           deletion = excluded.deletion, in_use = excluded.in_use, updated_at = now(),
           updated_by_actor = excluded.updated_by_actor
     returning id`,
    [
      tx.businessId,
      randomUUID(),
      row.dataClass,
      row.purpose,
      row.disclosures,
      row.retention,
      row.deletion,
      row.inUse,
      actorId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('data_classes: the upsert returned no row');
  return { id };
}

/**
 * The classes in use and their digest. A policy decision holds the register's
 * lock, so no change lands between this read and the decision made on it.
 */
export async function readDataClasses(tx: TenantQuery): Promise<DataClassesState> {
  const rows = await tx.query<{
    readonly data_class: string;
    readonly purpose: string;
    readonly disclosures: string;
    readonly retention: string;
    readonly deletion: string;
  }>(
    `select data_class, purpose, disclosures, retention, deletion
       from public.data_classes
      where business_id = $1 and in_use
      order by lower(data_class), id`,
    [tx.businessId],
  );
  const listed = rows.map((row) => ({
    dataClass: row.data_class,
    purpose: row.purpose,
    disclosures: row.disclosures,
    retention: row.retention,
    deletion: row.deletion,
  }));
  // The digest covers each class's words, in order.
  const canonical = JSON.stringify(
    listed.map((row) => [row.dataClass, row.purpose, row.disclosures, row.retention, row.deletion]),
  );
  return { listed, digest: createHash('sha256').update(canonical, 'utf8').digest('hex') };
}
