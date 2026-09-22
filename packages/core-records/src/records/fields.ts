// SPDX-License-Identifier: AGPL-3.0-only
//
// Field definitions: what a field is, where its slot comes from, and which
// writes the engine refuses.
//
// The classification lives on the field definition rather than in the task
// module, so every surface inherits the refusal (minimum contract, 5.1). A
// list held inside one module is a check to remember; a column on the field
// definition is a check that cannot be forgotten, and a conformance set can
// read it.

import { refuse, type RecordsRefusal } from './refusals.ts';
import { bySlotNumber, slotValueType, type Slot, type SlotValueType } from './slots.ts';

export type FieldValueType = SlotValueType | 'json';

/**
 * `generic` is edited directly. `operation` is owned by a named command, and a
 * generic write to it is refused. `system` is derived: no operation takes it as
 * an input, so nothing writes it through a field payload at all.
 */
export type WriteMode = 'generic' | 'operation' | 'system';

/** The external projection is built by allowlist from `shared` (minimum contract, 3.6). */
export type VisibilityClass = 'internal' | 'shared';

/** `core` is the migration's own; `preset` arrives through a sync at runtime. */
export type FieldOrigin = 'core' | 'preset';

export interface FieldDefinition {
  readonly id: string;
  readonly recordTypeId: string;
  readonly key: string;
  readonly valueType: FieldValueType;
  /** Null means the field lives in `data` and cannot be filtered, sorted or grouped. */
  readonly slot: string | null;
  readonly writeMode: WriteMode;
  readonly owningOperation: string | null;
  /**
   * The operation that owns this field when the write crosses an access
   * boundary, while an ordinary write inside the caller's existing reach stays
   * generic. Only containment fields carry one. The engine does not refuse on
   * it — `refuseGenericWrite` below lets a generic field through — so it is
   * read by the command that owns the boundary, and it is on the definition so
   * that command does not have to hold a list of its own.
   */
  readonly escalatingOperation: string | null;
  readonly visibilityClass: VisibilityClass;
  readonly searchable: boolean;
  readonly uniqueValue: boolean;
  readonly origin: FieldOrigin;
  /** A removed field deactivates and keeps its data; it never frees its slot. */
  readonly deactivatedAt: Date | null;
}

export function isLive(field: FieldDefinition): boolean {
  return field.deactivatedAt === null;
}

export interface SlotRequest {
  readonly valueType: FieldValueType;
  readonly origin: FieldOrigin;
  /** The core names the spine's slots. A preset asks for a type and takes what it is given. */
  readonly requestedSlot?: string;
}

/**
 * Which slot a new field gets, or why it gets none.
 *
 * A slot is never reused after a field is deactivated (fixed slots, 3.1), so
 * `taken` is every field of the record type that ever held one, live or not.
 * A reused slot carrying a stale backfill puts one field's values under
 * another field's name, which is the silent-wrong-column failure the whole
 * design exists to avoid.
 */
export function planSlotAssignment(
  request: SlotRequest,
  slots: readonly Slot[],
  taken: readonly FieldDefinition[],
): { readonly slot: string } | RecordsRefusal {
  if (request.valueType === 'json') {
    return refuse(
      'SLOT_UNKNOWN',
      ['json'],
      ['A json field lives in `data`. Model the value you want to filter on as its own field.'],
    );
  }
  const held = new Set(taken.map((field) => field.slot).filter((slot) => slot !== null));
  const ofType = slots
    .filter((slot) => slot.valueType === request.valueType)
    .toSorted(bySlotNumber);

  if (request.requestedSlot !== undefined) {
    return planNamedSlot(request, request.requestedSlot, ofType, held, taken);
  }

  const free = ofType.filter((slot) => !held.has(slot.slot));
  const permitted = free.filter((slot) => request.origin === 'core' || slot.reservation === null);
  if (permitted.length === 0) {
    return refuse('SLOT_TYPE_EXHAUSTED', holdersOf(request.valueType, taken), [
      `No free ${request.valueType} slot is left for this record type.`,
      'Deactivating a field does not free its slot; an audited reclaim does.',
      'The record type is over-modelled, or the slot table needs widening by migration.',
    ]);
  }
  const indexed = permitted.find((slot) => slot.indexed);
  if (indexed === undefined) {
    return refuse(
      'SLOT_INDEX_ABSENT',
      permitted.map((slot) => slot.slot),
      [
        'A free slot exists but carries no index, so slotting the field would not make it fast.',
        'Add the slot index by migration, then assign the field.',
      ],
    );
  }
  return { slot: indexed.slot };
}

function planNamedSlot(
  request: SlotRequest,
  named: string,
  ofType: readonly Slot[],
  held: ReadonlySet<string>,
  taken: readonly FieldDefinition[],
): { readonly slot: string } | RecordsRefusal {
  const slot = ofType.find((candidate) => candidate.slot === named);
  if (slot === undefined) {
    return refuse(
      'SLOT_UNKNOWN',
      [named, slotValueType(named) ?? 'unknown type'],
      [
        `No ${request.valueType} slot is named ${named}.`,
        'Slots are added by migration and never at runtime.',
      ],
    );
  }
  if (slot.reservation !== null && request.origin !== 'core') {
    return refuse(
      'SLOT_RESERVED',
      [named, slot.reservation],
      [`${named} is reserved by the core. A preset field takes a free slot of its type.`],
    );
  }
  if (held.has(named)) {
    return refuse(
      'SLOT_TYPE_EXHAUSTED',
      [named, ...taken.filter((field) => field.slot === named).map((field) => field.key)],
      [`${named} is already assigned in this record type, and a slot is never reused.`],
    );
  }
  if (!slot.indexed) {
    return refuse(
      'SLOT_INDEX_ABSENT',
      [named],
      [`${named} carries no index. Add it by migration, then assign the field.`],
    );
  }
  return { slot: named };
}

function holdersOf(
  valueType: FieldValueType,
  taken: readonly FieldDefinition[],
): readonly string[] {
  return taken
    .filter((field) => field.valueType === valueType && field.slot !== null)
    .map((field) => `${field.key}=${field.slot ?? ''}`)
    .toSorted();
}

/**
 * The generic-write refusal, and the reason it lives here rather than in the
 * task module: the app, the API, the CLI and any later generic editor all
 * reach records through this engine, so all of them inherit it and no
 * authority check sits in one transport alone.
 *
 * The order matters and is fixed rather than payload order, so the same
 * payload always draws the same code. An unknown key is reported first because
 * it is usually a typo and the rest of the diagnosis is wasted on it. A system
 * field comes next: a payload carrying one usually means the caller echoed a
 * whole record back, which is the larger misunderstanding to correct. An
 * operation-owned field comes last, and names the operation to call instead.
 */
export function refuseGenericWrite(
  fields: readonly FieldDefinition[],
  payloadKeys: readonly string[],
): RecordsRefusal | undefined {
  const live = new Map(fields.filter((field) => isLive(field)).map((f) => [f.key, f]));

  const unknown = payloadKeys.filter((key) => !live.has(key)).toSorted();
  if (unknown.length > 0) {
    return refuse('FIELD_UNKNOWN', unknown, [
      'This record type has no such field, or the field was deactivated.',
      'A deactivated field keeps its data and stops accepting writes.',
    ]);
  }

  const named = payloadKeys.map((key) => live.get(key)).filter((field) => field !== undefined);

  const derived = named.filter((field) => field.writeMode === 'system').toSorted(byKey);
  if (derived.length > 0) {
    return refuse(
      'FIELD_NOT_WRITABLE',
      derived.map((field) => field.key),
      [
        'This field is derived. No operation takes it as an input, on any surface.',
        'The attempted value goes to the audit, not to the response.',
      ],
    );
  }

  const owned = named.filter((field) => field.writeMode === 'operation').toSorted(byKey);
  if (owned.length > 0) {
    return refuse(
      'TRANSITION_PROTECTED',
      owned.map((field) => `${field.key}=${field.owningOperation ?? ''}`),
      ['Call the operation that owns the field. A generic edit cannot perform a transition.'],
    );
  }
  return undefined;
}

function byKey(left: FieldDefinition, right: FieldDefinition): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/** The canonical form a unique value is claimed under, matching the schema's own check. */
export function canonicalUniqueValue(value: string): string {
  return value.trim().toLowerCase();
}
