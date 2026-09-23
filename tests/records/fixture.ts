// SPDX-License-Identifier: AGPL-3.0-only
//
// Records written the way an installation writes them: through the application
// role, inside the tenancy wrapper. Nothing here uses the owner connection, so
// a fixture that only works as a superuser fails here rather than passing
// quietly and taking a test with it.
//
// `insertRecord` writes `data` and nothing else. It cannot set a slot, because
// no writer can: the trigger recomputes every slot from `data`. That is the
// property under test, so the fixture must not have a private path around it.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type {
  FieldOrigin,
  FieldValueType,
  VisibilityClass,
  WriteMode,
} from '../../packages/core-records/src/records/fields.ts';

export interface FieldSeed {
  readonly key: string;
  readonly valueType: FieldValueType;
  readonly slot?: string;
  readonly writeMode?: WriteMode;
  readonly owningOperations?: readonly string[];
  readonly visibilityClass?: VisibilityClass;
  readonly searchable?: boolean;
  readonly uniqueValue?: boolean;
  readonly origin?: FieldOrigin;
}

export async function insertRecordType(
  tx: TenantQuery,
  key: string,
  origin: FieldOrigin = 'core',
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into record_types (business_id, id, key, name, origin) values ($1, $2, $3, $4, $5)`,
    [tx.businessId, id, key, key, origin],
  );
  return id;
}

export async function insertField(
  tx: TenantQuery,
  recordTypeId: string,
  seed: FieldSeed,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into field_defs
       (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
        owning_operation, visibility_class, searchable, unique_value, origin)
     values ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      tx.businessId,
      id,
      recordTypeId,
      seed.key,
      seed.valueType,
      seed.slot ?? null,
      seed.writeMode ?? 'generic',
      seed.owningOperations ?? null,
      seed.visibilityClass ?? 'internal',
      seed.searchable ?? false,
      seed.uniqueValue ?? false,
      seed.origin ?? 'core',
    ],
  );
  return id;
}

export async function insertRecord(
  tx: TenantQuery,
  recordTypeId: string,
  data: Readonly<Record<string, unknown>>,
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
    [tx.businessId, id, recordTypeId, data],
  );
  return id;
}

export async function updateData(
  tx: TenantQuery,
  recordId: string,
  data: Readonly<Record<string, unknown>>,
): Promise<void> {
  await tx.query(`update records set data = $3 where business_id = $1 and id = $2`, [
    tx.businessId,
    recordId,
    data,
  ]);
}

export async function readRecord(
  tx: TenantQuery,
  recordId: string,
): Promise<Record<string, unknown>> {
  const rows = await tx.query<Record<string, unknown>>(
    `select * from records where business_id = $1 and id = $2`,
    [tx.businessId, recordId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`readRecord: ${recordId} is not there`);
  return row;
}
