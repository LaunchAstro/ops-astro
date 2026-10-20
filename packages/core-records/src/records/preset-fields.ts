// SPDX-License-Identifier: AGPL-3.0-only
//
// The field-definition rules a preset plan checks before it promises a field,
// the same rules `field_defs` holds as constraints. Split from `preset-plan.ts`
// to keep that file under the line limit.

/** What the checks read of a preset field (`PresetField`, not imported: that module imports this one). */
interface CheckedField {
  readonly key: string;
  readonly label: string;
  readonly valueType: string;
  readonly searchable?: boolean;
  /** A list of operation names on a good request; the body is the caller's, so anything here. */
  readonly owningOperations?: unknown;
}

const FIELD_KEY = /^[a-z][a-z0-9_]{0,62}$/u;
const OPERATION_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;

/**
 * Which fields `field_defs` would refuse on insert, so the dry run never
 * promises them (#867): a key outside its shape (`field_defs_key_present`), a
 * blank label (`field_defs_label_present`), a searchable field that is not
 * text, which alone is slotted for search (`field_defs_searchable_is_slotted_text`),
 * owning operations that are not a list, and an owning operation that is not
 * an operation name (`field_defs_operation_names_are_operations`), or names no
 * write the command catalogue has (`operations`, passed in: records may not
 * import the wire).
 */
export function invalidFields(
  fields: readonly CheckedField[],
  operations: ReadonlySet<string>,
): readonly string[] {
  return fields
    .filter(
      (field) =>
        !FIELD_KEY.test(field.key) ||
        typeof field.label !== 'string' ||
        field.label.trim().length === 0 ||
        (field.searchable === true && field.valueType !== 'text') ||
        !ownedByCatalogueWrites(field.owningOperations ?? [], operations),
    )
    .map((field) => field.key);
}

function ownedByCatalogueWrites(owning: unknown, operations: ReadonlySet<string>): boolean {
  return (
    Array.isArray(owning) &&
    owning.every(
      (name: unknown) =>
        typeof name === 'string' && OPERATION_NAME.test(name) && operations.has(name),
    )
  );
}
