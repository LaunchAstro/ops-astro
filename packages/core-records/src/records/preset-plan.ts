// SPDX-License-Identifier: AGPL-3.0-only
//
// `preset.plan`: what a preset would do to this business's model, computed
// without doing any of it.
//
// D05 is specific about what this may not be. Leaning on the database's
// refusal is not a sync plan: `field_defs.write_mode` is `not null` with no
// default, so an unclassified field is already impossible to insert — but that
// refusal arrives mid-apply, after some of the preset has landed, and it
// arrives as a constraint violation rather than as an answer about the
// preset. Refusing every plan is not one either. So this accepts a valid plan,
// says what it would do, and refuses an unclassified field *before* anything
// is applied.
//
// "Before anything" is the load-bearing word and is why the whole plan is
// validated before any action is emitted, including the fields that are
// perfectly fine. A planner that applied the good half and refused the bad one
// would leave a business half-synced to a preset nobody approved, which is
// worse than not syncing at all: the next run sees some of the preset already
// there and cannot tell what it decided from what it inherited.
//
// It writes nothing at all, ever, including on success. Applying the plan is a
// separate authorised operation; this one answers a question.

import { checkAuthority, type Subject } from '../authority/grants.ts';
import { readFieldDefinitions } from './field-store.ts';
import { planSlotAssignment, type FieldOrigin, type FieldValueType } from './fields.ts';
import { isRecordsRefusal } from './refusals.ts';
import { readSlotTable, type Slot } from './slots.ts';
import type { TenantQuery } from '../tenancy/database.ts';

/**
 * This module's own codes, not widened into the records register.
 *
 * `commands/register.ts` derives its `RefusalCode` from that register and the
 * register is L3's; a planner reaching into the command surface to add a code
 * is the coupling the register exists to prevent. L3 registers these with the
 * rest when it wires the endpoint.
 */
export type PresetPlanRefusalCode =
  /** A field arrived with no `write_mode`, or with one the model does not have. */
  | 'PRESET_FIELD_UNCLASSIFIED'
  /** The record type the preset names is not installed in this business. */
  | 'PRESET_TYPE_UNKNOWN'
  /** The field cannot be placed: no free slot of its type, or none indexed. */
  | 'PRESET_FIELD_UNPLACEABLE'
  /** The caller holds no live `manage` grant on presets. */
  | 'SCOPE_NOT_GRANTED';

export interface PresetPlanRefusal {
  readonly code: PresetPlanRefusalCode;
  /** The fields the refusal is about, by key. Never a value the caller did not send. */
  readonly names: readonly string[];
  readonly fixes: readonly string[];
}

export type PresetPlanDecision<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: PresetPlanRefusal };

/** One field as a preset ships it. Everything a classification needs is on it. */
export interface PresetField {
  readonly key: string;
  readonly label: string;
  readonly valueType: FieldValueType;
  /** No default. A field nobody classified is a field nobody decided about. */
  readonly writeMode?: string;
  readonly owningOperations?: readonly string[];
  readonly visibilityClass?: string;
  readonly searchable?: boolean;
  readonly uniqueValue?: boolean;
}

export interface PresetSyncRequest {
  readonly recordTypeKey: string;
  readonly presetKey: string;
  readonly fields: readonly PresetField[];
}

export type PlannedAction =
  | { readonly action: 'create_field'; readonly key: string; readonly slot: string }
  | { readonly action: 'create_unslotted_field'; readonly key: string }
  | { readonly action: 'no_change'; readonly key: string };

export interface PresetPlan {
  readonly recordTypeId: string;
  readonly presetKey: string;
  readonly actions: readonly PlannedAction[];
}

/** The caller, as the two identities a grant may name. */
export interface Planner {
  readonly personId: string;
  readonly actorId: string;
}

const WRITE_MODES = new Set(['generic', 'operation', 'system']);
const VISIBILITY_CLASSES = new Set(['internal', 'shared']);
const PRESET_COLLECTION = 'preset';
const PRESET_ORIGIN: FieldOrigin = 'preset';

function refuse(
  code: PresetPlanRefusalCode,
  names: readonly string[],
  fixes: readonly string[],
): PresetPlanDecision<never> {
  return { ok: false, refusal: { code, names, fixes } };
}

/**
 * Which fields of this preset are unclassified.
 *
 * "Unclassified" is both halves: absent, and present but not one of the three
 * the model has. A preset shipping `write_mode: 'sometimes'` has not been
 * decided about either, and defaulting it to `generic` would open a field
 * nobody opened.
 */
function unclassified(fields: readonly PresetField[]): readonly string[] {
  return fields
    .filter((field) => {
      if (field.writeMode === undefined || !WRITE_MODES.has(field.writeMode)) return true;
      if (field.visibilityClass !== undefined && !VISIBILITY_CLASSES.has(field.visibilityClass)) {
        return true;
      }
      // An operation-owned field names its operations, and nothing else does:
      // `field_defs_operation_named`, checked here so the plan says so rather
      // than the insert.
      const names = field.owningOperations ?? [];
      return (field.writeMode === 'operation') !== names.length > 0;
    })
    .map((field) => field.key);
}

async function recordTypeId(tx: TenantQuery, key: string): Promise<string | undefined> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from record_types where business_id = $1 and key = $2`,
    [tx.businessId, key],
  );
  return rows[0]?.id;
}

async function slotTable(tx: TenantQuery): Promise<readonly Slot[]> {
  return await readSlotTable(async (text, parameters) => await tx.query(text, parameters));
}

/**
 * Plan a preset sync. Reads authority, reads the model, writes nothing.
 *
 * The order is deliberate. Authority first, so an unauthorised caller learns
 * nothing about what is installed. The classification of the whole preset
 * next, so the refusal is about the preset rather than about the first field
 * that happened to fail. Placement last, because a field that cannot be
 * placed is a different answer from one that was never classified.
 */
export async function planPresetSync(
  tx: TenantQuery,
  planner: Planner,
  request: PresetSyncRequest,
): Promise<PresetPlanDecision<PresetPlan>> {
  const subjects: readonly Subject[] = [
    { kind: 'person', id: planner.personId },
    { kind: 'actor', id: planner.actorId },
  ];
  const authorised = await checkAuthority(tx, subjects, {
    collection: PRESET_COLLECTION,
    action: 'manage',
    scope: { kind: 'business', id: null },
  });
  if (!authorised.ok) {
    return refuse('SCOPE_NOT_GRANTED', [], [authorised.refusal.reason, authorised.refusal.fix]);
  }

  const unclear = unclassified(request.fields);
  if (unclear.length > 0) {
    return refuse('PRESET_FIELD_UNCLASSIFIED', unclear, [
      'Every field a preset ships carries a write mode: generic, operation or system.',
      'An operation-owned field names its operations, and no other field names any.',
      'Nothing of this plan was applied.',
    ]);
  }

  const typeId = await recordTypeId(tx, request.recordTypeKey);
  if (typeId === undefined) {
    return refuse(
      'PRESET_TYPE_UNKNOWN',
      [request.recordTypeKey],
      ['This business has no record type by that key. Install the type before syncing a preset.'],
    );
  }

  const installed = await readFieldDefinitions(tx, typeId);
  const byKey = new Map(installed.map((field) => [field.key, field]));
  const slots = await slotTable(tx);
  // The plan's own view of what is taken: the installed fields plus the ones
  // earlier in this plan, because two preset fields of one type cannot both be
  // given the same free slot.
  const taken = [...installed];
  const actions: PlannedAction[] = [];

  for (const field of request.fields) {
    if (byKey.has(field.key)) {
      actions.push({ action: 'no_change', key: field.key });
      continue;
    }
    if (field.valueType === 'json') {
      actions.push({ action: 'create_unslotted_field', key: field.key });
      continue;
    }
    const placed = planSlotAssignment(
      { valueType: field.valueType, origin: PRESET_ORIGIN },
      slots,
      taken,
    );
    if (isRecordsRefusal(placed)) {
      return refuse(
        'PRESET_FIELD_UNPLACEABLE',
        [field.key],
        [...placed.fixes, 'Nothing of this plan was applied.'],
      );
    }
    actions.push({ action: 'create_field', key: field.key, slot: placed.slot });
    taken.push({
      id: `planned:${field.key}`,
      recordTypeId: typeId,
      key: field.key,
      valueType: field.valueType,
      slot: placed.slot,
      writeMode: 'generic',
      owningOperations: [],
      owningOperation: null,
      escalatingOperation: null,
      visibilityClass: 'internal',
      searchable: false,
      uniqueValue: false,
      origin: PRESET_ORIGIN,
      deactivatedAt: null,
    });
  }

  return { ok: true, value: { recordTypeId: typeId, presetKey: request.presetKey, actions } };
}
