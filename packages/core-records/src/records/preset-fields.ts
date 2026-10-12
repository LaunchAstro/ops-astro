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
  readonly owningOperations?: readonly string[];
}

const FIELD_KEY = /^[a-z][a-z0-9_]{0,62}$/u;
const OPERATION_NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u;

/**
 * Which fields `field_defs` would refuse on insert, so the dry run never
 * promises them (#867): a key outside its shape (`field_defs_key_present`), a
 * blank label (`field_defs_label_present`), a searchable field that is not
 * text, which alone is slotted for search (`field_defs_searchable_is_slotted_text`),
 * and an owning operation that is not an operation name
 * (`field_defs_operation_names_are_operations`).
 */
export function invalidFields(fields: readonly CheckedField[]): readonly string[] {
  return fields
    .filter(
      (field) =>
        !FIELD_KEY.test(field.key) ||
        typeof field.label !== 'string' ||
        field.label.trim().length === 0 ||
        (field.searchable === true && field.valueType !== 'text') ||
        (field.owningOperations ?? []).some((name) => !OPERATION_NAME.test(name)),
    )
    .map((field) => field.key);
}
