// SPDX-License-Identifier: AGPL-3.0-only
//
// Installing the task type into one business.
//
// This is a runtime write, not a migration, and it has to be: `record_types`
// and `field_defs` carry `business_id`, so the task type exists once per
// business and a business is created long after the schema is. Adding a record
// type writes metadata rows and never creates a table, a column or an index
// (ADR 0030), which is the whole reason the installer can run at runtime at
// all.
//
// It goes through `planSlotAssignment` rather than writing the slot names it
// already knows. The engine's refusals — `SLOT_RESERVED`,
// `SLOT_TYPE_EXHAUSTED`, `SLOT_INDEX_ABSENT`, `SLOT_UNKNOWN` — are the same
// ones a preset sync will meet, so the core takes the same path a preset does
// and a spine that has drifted from the migration fails here, loudly, on the
// first install rather than on the first filter.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { planSlotAssignment, type FieldDefinition } from '../records/fields.ts';
import { readSlotTable, type Slot } from '../records/slots.ts';
import { isRecordsRefusal } from '../records/refusals.ts';
import { TASK_SPINE, TASK_TYPE_KEY, type SpineField } from './spine.ts';
import { COMMENT_SPINE, COMMENT_TYPE_KEY } from './comments.ts';
import { TASK_STATE_FIELDS, TASK_STATE_SEED, TASK_STATE_TYPE_KEY } from './states.ts';
import { reconcileVisibility } from './reconcile-visibility.ts';

export interface InstalledTaskSpine {
  readonly taskTypeId: string;
  readonly taskStateTypeId: string;
  /** The comment type, installed beside the task type so D01 covers it too. */
  readonly taskCommentTypeId: string;
  /** The five seeded states by key, so a caller need not read them back. */
  readonly stateIds: Readonly<Record<string, string>>;
  /**
   * True when this call installed the task type itself; false when it was
   * already there, including when this call added only the comment type to it.
   */
  readonly installed: boolean;
}

/** `ops.slots` is readable by the application role, so the wrapper can read it. */
async function slotTable(tx: TenantQuery): Promise<readonly Slot[]> {
  return await readSlotTable(async (text, parameters) => await tx.query(text, parameters));
}

async function findRecordType(tx: TenantQuery, key: string): Promise<string | undefined> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from record_types where business_id = $1 and key = $2`,
    [tx.businessId, key],
  );
  return rows[0]?.id;
}

async function createRecordType(tx: TenantQuery, key: string, name: string): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `insert into record_types (business_id, id, key, name, origin, retention_class)
     values ($1, $2, $3, $4, 'core', 'work')`,
    [tx.businessId, id, key, name],
  );
  return id;
}

/**
 * One field, placed by the engine rather than by this file's own opinion.
 *
 * `taken` is every field of the record type written so far in this install, in
 * the shape the engine reads, because a slot is never reused and the engine
 * has to see the ones already spoken for.
 */
async function createField(
  tx: TenantQuery,
  recordTypeId: string,
  field: SpineField,
  slots: readonly Slot[],
  taken: FieldDefinition[],
): Promise<string> {
  let slot: string | null = null;
  if (field.slot !== null) {
    const plan = planSlotAssignment(
      { valueType: field.valueType, origin: 'core', requestedSlot: field.slot },
      slots,
      taken,
    );
    if (isRecordsRefusal(plan)) {
      throw new Error(
        `installTaskSpine: the core cannot place its own field ${field.key} in ${field.slot}: ` +
          `${plan.code} (${plan.names.join(', ')})`,
      );
    }
    slot = plan.slot;
  }

  const id = randomUUID();
  await tx.query(
    `insert into field_defs
       (business_id, id, record_type_id, key, label, value_type, slot, write_mode,
        owning_operation, escalating_operation, visibility_class, searchable,
        unique_value, origin)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'core')`,
    [
      tx.businessId,
      id,
      recordTypeId,
      field.key,
      field.label,
      field.valueType,
      slot,
      field.writeMode,
      field.owningOperations.length === 0 ? null : field.owningOperations,
      field.escalatingOperation,
      // Deny by default. Which fields a client projection may see is a product
      // policy for the portal slice, and a field that leaks because nobody
      // decided is the failure an allowlist exists to prevent.
      field.visibilityClass ?? 'internal',
      field.searchable ?? false,
      field.uniqueValue ?? false,
    ],
  );

  taken.push({
    id,
    recordTypeId,
    key: field.key,
    valueType: field.valueType,
    slot,
    writeMode: field.writeMode,
    owningOperations: field.owningOperations,
    owningOperation: field.owningOperations.length === 0 ? null : field.owningOperations.join(' '),
    escalatingOperation: field.escalatingOperation,
    visibilityClass: field.visibilityClass ?? 'internal',
    searchable: field.searchable ?? false,
    uniqueValue: field.uniqueValue ?? false,
    origin: 'core',
    deactivatedAt: null,
  });
  return id;
}

async function createFields(
  tx: TenantQuery,
  recordTypeId: string,
  fields: readonly SpineField[],
  slots: readonly Slot[],
): Promise<void> {
  const taken: FieldDefinition[] = [];
  for (const field of fields) {
    // One at a time on purpose. Each field's slot is planned against the ones
    // already taken, so the next decision depends on the last write. Running
    // them together would ask the engine which slot is free while the answer
    // was still being decided.
    // oxlint-disable-next-line no-await-in-loop
    await createField(tx, recordTypeId, field, slots, taken);
  }
}

/**
 * The five states, as records of the state type.
 *
 * They are records rather than a table, so the set is data: a preset sync can
 * rename a label or install a different set without a migration, which is the
 * point of moving the coarseness into data (specification, 14.5 point 3). What
 * a *generic* write cannot do is invent one, because `key` and
 * `machine_category` are system-classified. `data` is the only thing written
 * here; the slots are the trigger's.
 */
async function seedStates(
  tx: TenantQuery,
  taskStateTypeId: string,
): Promise<Record<string, string>> {
  const stateIds: Record<string, string> = {};
  for (const seed of TASK_STATE_SEED) {
    const id = randomUUID();
    // Sequential because they share one connection inside one transaction, and
    // because a partly-seeded state set is worse than a slow one.
    // oxlint-disable-next-line no-await-in-loop
    await tx.query(
      `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
      [
        tx.businessId,
        id,
        taskStateTypeId,
        {
          key: seed.key,
          label: seed.label,
          machine_category: seed.machineCategory,
          position: seed.position,
        },
      ],
    );
    stateIds[seed.key] = id;
  }
  return stateIds;
}

async function readStates(
  tx: TenantQuery,
  taskStateTypeId: string,
): Promise<Record<string, string>> {
  const rows = await tx.query<{ readonly id: string; readonly key: string }>(
    `select id, data ->> 'key' as key from records
      where business_id = $1 and record_type_id = $2 and deleted_at is null`,
    [tx.businessId, taskStateTypeId],
  );
  const stateIds: Record<string, string> = {};
  for (const row of rows) stateIds[row.key] = row.id;
  return stateIds;
}

/**
 * The comment type, added beside a task type that is already installed.
 *
 * Its slots are planned against an empty `taken` because the type is new: a
 * slot is reserved per record type, so a comment field never competes with a
 * task field for one.
 */
async function addCommentType(tx: TenantQuery): Promise<string> {
  const slots = await slotTable(tx);
  const commentTypeId = await createRecordType(tx, COMMENT_TYPE_KEY, 'Task comment');
  await createFields(tx, commentTypeId, COMMENT_SPINE, slots);
  return commentTypeId;
}

/**
 * Install the task type and its states, or return what is already there.
 *
 * Idempotent by the record type's key, which is unique per business, so a
 * second call after a partial failure cannot produce two task types. It writes
 * inside the caller's transaction, so a failure part-way through leaves no
 * half-installed type behind.
 */
export async function installTaskSpine(tx: TenantQuery): Promise<InstalledTaskSpine> {
  const existing = await findRecordType(tx, TASK_TYPE_KEY);
  if (existing !== undefined) {
    const stateTypeId = await findRecordType(tx, TASK_STATE_TYPE_KEY);
    if (stateTypeId === undefined) {
      throw new Error('installTaskSpine: the task type is installed and the state type is not');
    }
    // A business installed before the comment type existed has `task` and
    // `task_state` and no `task_comment`. That is an ordinary earlier shape,
    // not corruption, and the installer's job is to bring it forward: add the
    // missing type and its fields, touch nothing that is already there. The
    // task and state type ids, their field rows and every task record survive,
    // because nothing below rewrites them, bar the two visibility classes.
    const commentTypeId =
      (await findRecordType(tx, COMMENT_TYPE_KEY)) ?? (await addCommentType(tx));
    // The one exception to "touch nothing": title and state's visibility, the
    // I09 ruling an install from before it never received.
    await reconcileVisibility(tx, existing);
    return {
      taskTypeId: existing,
      taskStateTypeId: stateTypeId,
      taskCommentTypeId: commentTypeId,
      stateIds: await readStates(tx, stateTypeId),
      installed: false,
    };
  }

  const slots = await slotTable(tx);
  // The state type first: a task's `state` points at one of its records, so
  // installing the task type before its states would leave a spine field
  // whose referent does not exist yet.
  const taskStateTypeId = await createRecordType(tx, TASK_STATE_TYPE_KEY, 'Task state');
  await createFields(tx, taskStateTypeId, TASK_STATE_FIELDS, slots);
  const stateIds = await seedStates(tx, taskStateTypeId);

  const taskTypeId = await createRecordType(tx, TASK_TYPE_KEY, 'Task');
  await createFields(tx, taskTypeId, TASK_SPINE, slots);

  // The comment type last: it points at a task, and a type whose referent does
  // not exist yet is the same ordering mistake the state type avoids above.
  const taskCommentTypeId = await createRecordType(tx, COMMENT_TYPE_KEY, 'Task comment');
  await createFields(tx, taskCommentTypeId, COMMENT_SPINE, slots);

  return { taskTypeId, taskStateTypeId, taskCommentTypeId, stateIds, installed: true };
}
