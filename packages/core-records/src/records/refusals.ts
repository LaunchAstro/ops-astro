// SPDX-License-Identifier: AGPL-3.0-only
//
// The typed refusals the records engine can produce.
//
// A refusal is returned, never thrown, for the reason the identity module's
// register gives: a thrown refusal becomes error handling, and error handling
// is where a refusal turns into a 500 or into an empty result that reads like
// "there is nothing here" (minimum contract, section 4.4).
//
// These differ from the identity refusals in one way, and it is deliberate.
// An identity refusal carries no value at all, because which of several
// reasons applied is an inference channel across a tenancy boundary. A records
// refusal *names things*: the field that has no slot, the operation that owns
// a protected field, the fields holding the last slots of a type. The contract
// requires each of those by name (fixed slots, 3.2 and 5.3), and they are all
// configuration the caller is already inside the business to see. What is
// never named is another business's anything: a cross-business record is
// `NOT_FOUND` and that refusal belongs to T1f's register, not here.

export type RecordsRefusalCode =
  /** A view names a field with no slot for a filter, a sort or a grouping. */
  | 'FIELD_NOT_SLOTTED'
  /** A view groups on a slotted field whose values are not a bounded set. */
  | 'FIELD_NOT_GROUPABLE'
  /** A view names a field this record type does not have, or no longer has. */
  | 'FIELD_UNKNOWN'
  /** A view traverses more than one link hop. There are no user-defined joins. */
  | 'VIEW_HOP_LIMIT'
  /** A preset field named a slot the core reserved for the task spine. */
  | 'SLOT_RESERVED'
  /** No free slot of the needed type. The record type is over-modelled. */
  | 'SLOT_TYPE_EXHAUSTED'
  /** A free slot exists and carries no index, so slotting there would not be fast. */
  | 'SLOT_INDEX_ABSENT'
  /** A named slot is not in the slot catalogue, or is the wrong type for the field. */
  | 'SLOT_UNKNOWN'
  /** A generic write reached a field owned by an operation. */
  | 'TRANSITION_PROTECTED'
  /** A generic write reached a derived field no operation takes as input. */
  | 'FIELD_NOT_WRITABLE'
  // The task type's own refusals. They are in this register rather than a
  // second one because they are returned by the same engine and carry the same
  // shape, and two registers is how one of them stops being audited.
  /** The record does not exist, or exists in another business. Deliberately one code. */
  | 'NOT_FOUND'
  /** A create payload chose something the server derives: a rank, a subtask's section. */
  | 'PLACEMENT_IS_DERIVED'
  /** A restore, or an addition, reached a record whose parent is still in the trash. */
  | 'PARENT_TRASHED'
  /** The subtree root is already in the trash, in the batch this names. */
  | 'ALREADY_TRASHED'
  /** A restore would re-claim a unique value that someone else took meanwhile. */
  | 'UNIQUE_VALUE_TAKEN'
  /** A purge named something outside the work retention class. */
  | 'RETENTION_CLASS_PROTECTED';

export interface RecordsRefusal {
  readonly refused: true;
  readonly code: RecordsRefusalCode;
  /**
   * What the refusal is about, by name: field keys, slot names, the owning
   * operation. In-business configuration only, never a value a caller wrote
   * and never anything belonging to another business.
   */
  readonly names: readonly string[];
  /** What a person could do about it. */
  readonly fixes: readonly string[];
}

export function refuse(
  code: RecordsRefusalCode,
  names: readonly string[],
  fixes: readonly string[],
): RecordsRefusal {
  return { refused: true, code, names, fixes };
}

/** The discriminant, so a caller can tell a result from a refusal. */
export function isRecordsRefusal(value: object): value is RecordsRefusal {
  return 'refused' in value && value.refused === true;
}
