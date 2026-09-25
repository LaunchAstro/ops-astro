// SPDX-License-Identifier: AGPL-3.0-only
//
// Reading field definitions back out of the database.
//
// `fields.ts` is deliberately pure: it decides slots and refusals and knows
// nothing about a connection, so its rules can be exercised without a server.
// Something still has to hand it the rows, and this is that something. It is a
// separate file so the pure module stays pure — the moment a decision function
// can reach a database, a test of the decision becomes a test of the database.
//
// Deactivated fields are read too. `refuseGenericWrite` needs to tell "this
// record type never had that field" from "that field was deactivated and keeps
// its data", and a reader that filtered them out would collapse the two.

import type { TenantQuery } from '../tenancy/database.ts';
import type { FieldDefinition, FieldValueType, WriteMode } from './fields.ts';
import type { VisibilityClass, FieldOrigin } from './fields.ts';

interface FieldRow {
  readonly id: string;
  readonly record_type_id: string;
  readonly key: string;
  readonly value_type: FieldValueType;
  readonly slot: string | null;
  readonly write_mode: WriteMode;
  readonly owning_operation: readonly string[] | null;
  readonly escalating_operation: string | null;
  readonly visibility_class: VisibilityClass;
  readonly searchable: boolean;
  readonly unique_value: boolean;
  readonly origin: FieldOrigin;
  readonly deactivated_at: Date | null;
}

export async function readFieldDefinitions(
  tx: TenantQuery,
  recordTypeId: string,
): Promise<readonly FieldDefinition[]> {
  const rows = await tx.query<FieldRow>(
    `select id, record_type_id, key, value_type, slot, write_mode, owning_operation,
            escalating_operation, visibility_class, searchable, unique_value, origin,
            deactivated_at
       from field_defs
      where business_id = $1 and record_type_id = $2
      order by key`,
    [tx.businessId, recordTypeId],
  );
  return rows.map((row) => ({
    id: row.id,
    recordTypeId: row.record_type_id,
    key: row.key,
    valueType: row.value_type,
    slot: row.slot,
    writeMode: row.write_mode,
    owningOperations: row.owning_operation ?? [],
    owningOperation: joinOperations(row.owning_operation),
    escalatingOperation: row.escalating_operation,
    visibilityClass: row.visibility_class,
    searchable: row.searchable,
    uniqueValue: row.unique_value,
    origin: row.origin,
    deactivatedAt: row.deactivated_at,
  }));
}

/**
 * The spelling 0004's readers branch on, from the column 0009 holds.
 *
 * Null rather than empty for an unowned field, because that is the value those
 * readers test, and an empty string would look like a name.
 */
function joinOperations(stored: readonly string[] | null): string | null {
  return stored === null || stored.length === 0 ? null : stored.join(' ');
}
