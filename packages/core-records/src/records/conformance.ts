// SPDX-License-Identifier: AGPL-3.0-only
//
// The domain-model conformance set, as far as this part can carry it.
//
// The specification names six assertions for the domain model (section 11).
// Four of them need something T1d does not build, and saying which is the
// point of writing them down here rather than quietly proving the easy ones:
//
//   1. Every slot-assigned field of every record type has a non-null
//      `write_mode`.                                            CARRIED, below.
//   2. No field in the protected set is `generic`, asserted by name.
//      NOT CARRIED: the protected set is the task type's fields, and the task
//      type is seeded by T1e. The engine half — that a generic write to a
//      non-generic field is refused — is `refuseGenericWrite`, and its unit
//      cases stand in this part.
//   3. A generic write to each protected field is refused on each of the three
//      surfaces, and a surface that refuses what another allows fails too.
//      NOT CARRIED: there are no surfaces yet. T1g.
//   4. Each protected field's `owning_operation` exists and is reachable
//      through an endpoint.  NOT CARRIED: the operations are T1f's.
//   5. A preset shipping an unclassified field fails the sync plan rather than
//      the build.  NOT CARRIED: there is no preset sync. The database refuses
//      an unclassified field outright, which is stricter and is asserted here.
//   6. No field classified `system` is writable through any command's
//      field-value payload, attempted on every surface.  NOT CARRIED: needs
//      commands and surfaces. The engine refusal is `refuseGenericWrite`.
//
// What this module adds beyond assertion 1 is the set of rules that keep the
// slot table honest: that the registry and the columns agree, that every
// assigned slot exists and is indexed, and that a slot is never shared. Like
// T1a's set it reads the catalogue of a database migrated from empty, because
// the catalogue is what the server built.

import type { AdminConnection } from '../tenancy/database.ts';
import type { Finding } from '../tenancy/conformance.ts';
import { readSlotColumns, readSlotTable, SLOT_SQL_TYPE } from './slots.ts';

type Read = AdminConnection['execute'];

interface FieldRow {
  readonly record_type_key: string;
  readonly key: string;
  readonly value_type: string;
  readonly slot: string | null;
  readonly origin: string;
  readonly write_mode: string | null;
  readonly owning_operation: string | null;
  readonly visibility_class: string | null;
}

interface ConstraintRow {
  readonly conname: string;
}

/**
 * Every field of every record type in the database, across every business.
 * Read as the owner, because a conformance set that only sees one tenant's
 * configuration has not checked the installation.
 */
async function fields(read: Read): Promise<readonly FieldRow[]> {
  return await read<FieldRow>(
    `select t.key as record_type_key, f.key, f.value_type, f.slot, f.origin,
            f.write_mode, f.owning_operation, f.visibility_class
       from public.field_defs f
       join public.record_types t
         on t.business_id = f.business_id and t.id = f.record_type_id
      order by t.key, f.key`,
  );
}

/** The rules that hold with no rows at all: the schema's own refusals. */
async function schemaRules(read: Read): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const required = [
    'field_defs_write_mode_known',
    'field_defs_operation_named',
    'field_defs_visibility_class_known',
    'field_defs_slot_matches_type',
    'field_defs_searchable_is_slotted_text',
  ];
  const present = await read<ConstraintRow>(
    `select conname from pg_constraint c
       join pg_class t on t.oid = c.conrelid
      where t.relname = 'field_defs' and c.contype = 'c'`,
  );
  const names = new Set(present.map((row) => row.conname));
  for (const constraint of required) {
    if (names.has(constraint)) continue;
    findings.push({
      rule: 'the field definition refuses an unclassified field in the schema',
      object: `field_defs.${constraint}`,
      detail: 'the constraint is absent, so a field could be written without a classification',
    });
  }

  const nullable = await read<{ readonly column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'field_defs'
        and column_name in ('write_mode', 'visibility_class') and is_nullable = 'YES'`,
  );
  for (const column of nullable) {
    findings.push({
      rule: 'every field carries a classification, with no null to mean "not decided"',
      object: `field_defs.${column.column_name}`,
      detail: 'the column is nullable',
    });
  }
  return findings;
}

/** The registry and the columns are one fact, read from both places. */
async function slotTableAgrees(read: Read): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const slots = await readSlotTable(read);
  const columns = await readSlotColumns(read);
  const byName = new Map(columns.map((column) => [column.column, column.type]));

  for (const slot of slots) {
    const type = byName.get(slot.slot);
    if (type === undefined) {
      findings.push({
        rule: 'every registered slot is a column on records',
        object: slot.slot,
        detail: 'the registry names a slot the table does not have',
      });
      continue;
    }
    if (type !== SLOT_SQL_TYPE[slot.valueType]) {
      findings.push({
        rule: 'a registered slot has the type its name claims',
        object: slot.slot,
        detail: `registered ${slot.valueType}, stored as ${type}`,
      });
    }
    byName.delete(slot.slot);
  }
  for (const [column] of byName) {
    findings.push({
      rule: 'every slot column on records is registered',
      object: column,
      detail: 'the table has a slot the registry does not name, so nothing can assign it',
    });
  }

  for (const slot of slots.filter((each) => each.reservation !== null && !each.indexed)) {
    findings.push({
      rule: 'every reserved slot carries an index',
      object: slot.slot,
      detail: `reserved for ${slot.reservation ?? ''} and unindexed, so the spine would not be fast`,
    });
  }
  return findings;
}

/**
 * The domain model as configured. Assertion 1 plus the slot rules that make it
 * mean something: an assigned slot that does not exist, or that two fields
 * share, would satisfy "has a write mode" and still be wrong.
 */
export async function domainModelConformance(read: Read): Promise<readonly Finding[]> {
  const findings: Finding[] = [...(await schemaRules(read)), ...(await slotTableAgrees(read))];
  const slots = new Map((await readSlotTable(read)).map((slot) => [slot.slot, slot]));
  const rows = await fields(read);
  const seen = new Map<string, string>();

  for (const row of rows) {
    const where = `${row.record_type_key}.${row.key}`;
    if (row.slot !== null && (row.write_mode === null || row.write_mode === '')) {
      findings.push({
        rule: 'every slot-assigned field has a non-null write mode',
        object: where,
        detail: 'the field is slotted and unclassified',
      });
    }
    if (row.write_mode === 'operation' && row.owning_operation === null) {
      findings.push({
        rule: 'an operation-owned field names the operation that owns it',
        object: where,
        detail: 'write mode is operation with no owning operation',
      });
    }
    if (row.write_mode !== 'operation' && row.owning_operation !== null) {
      findings.push({
        rule: 'only an operation-owned field names an operation',
        object: where,
        detail: `write mode is ${row.write_mode ?? 'null'} and names ${row.owning_operation}`,
      });
    }
    if (row.slot === null) continue;

    const slot = slots.get(row.slot);
    if (slot === undefined) {
      findings.push({
        rule: 'an assigned slot exists in the slot catalogue',
        object: where,
        detail: `assigned to ${row.slot}, which is not a slot`,
      });
      continue;
    }
    if (slot.valueType !== row.value_type) {
      findings.push({
        rule: 'an assigned slot has the type of the field in it',
        object: where,
        detail: `${row.value_type} field in a ${slot.valueType} slot`,
      });
    }
    // The reservation's second enforcement point. `planSlotAssignment` refuses
    // a preset field a reserved slot, and until this assertion existed that
    // refusal was the only thing standing in the way: a direct insert into
    // `field_defs` reached a spine slot with nothing to say so. A rule with one
    // enforcement point is a rule the next entry point forgets, which is the
    // reasoning the trigger was built on and this closes the same hole.
    if (slot.reservation !== null && row.origin !== 'core') {
      findings.push({
        rule: 'a reserved slot holds a core field only',
        object: where,
        detail: `${row.slot} is reserved for ${slot.reservation}, and this field is ${row.origin}`,
      });
    }
    if (!slot.indexed) {
      findings.push({
        rule: 'an assigned slot carries an index, so a slotted field is a fast field',
        object: where,
        detail: `${row.slot} has no index`,
      });
    }
    const key = `${row.record_type_key}:${row.slot}`;
    const holder = seen.get(key);
    if (holder !== undefined) {
      findings.push({
        rule: 'one field per slot per record type',
        object: where,
        detail: `${row.slot} is also held by ${holder}`,
      });
    }
    seen.set(key, row.key);
  }
  return findings;
}
