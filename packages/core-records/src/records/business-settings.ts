// SPDX-License-Identifier: AGPL-3.0-only
//
// The business settings the model has been reading without having.
//
// Four landed contracts name a per-business setting and none of them could
// read one: the four-eyes band (default five hundred, "off" permitted), the
// retention window, the conversation window and the client sign-off
// requirement. The completion item named the table; 0009 built it; this is the
// producer that puts the named rows into a business.
//
// The classification is the point, not the values. A setting that decides
// whether a second approver is needed is not ordinary configuration, and
// `write_mode` on the row says so the same way it says it on a field
// definition: `operation` means a named command owns it and a generic edit is
// refused. There is no default in the column, for the reason 0004 gives about
// fields — a setting nobody classified is a setting nobody decided about.
//
// Installing is additive and never resets. A second install adds what is
// missing and leaves every value alone, because the alternative is an upgrade
// that quietly returns a business's retention window to the shipped default.
//
// ## The revision, and the interface a command wires to (0020)
//
// Every setting carries a `revision` (`integer`, starting at 1) and both
// readers hand it back, so the mechanism a record has had since 0005 is
// available on a setting: a caller reads, writes against the revision it read,
// and is refused rather than merged when the row has moved on. Without it two
// administrators editing one row from two browser tabs both wrote, and the
// second silently replaced the first with a value chosen before the first
// existed.
//
// The interface, pinned so a command can wire to it without guessing:
//
// - **The read result.** `BusinessSetting.revision: number`, on every setting,
//   from `readBusinessSettings` and `readBusinessSetting` alike.
// - **The write input.** `writeBusinessSetting(tx, write)` with
//   `expectedRevision?: number`. It is *optional*: absent, the write proceeds
//   and still returns the new revision, which is what a caller that has not
//   learnt to send one does today.
// - **The stale result.** `SettingRevisionStale`, which is the shape the
//   records engine's refusals carry (`refused`, `code`, `names`, `fixes`) with
//   the code the command register already holds for this answer,
//   `VERSION_STALE`, and `names` of `revision=<the one the row is at>`. It is
//   returned, never thrown, for the reason `records/refusals.ts` gives. A
//   caller at the command boundary passes it straight to `refuseCommand`.
// - **Nothing to write.** `undefined`, for a key this business has no row for
//   and for an operation-owned row the named operation does not own. One
//   answer, because both are "there is no row here you may write" and the
//   caller turns it into its own `NOT_FOUND`.
//
// The value is *not* type-checked here against the row's declared type. The
// database's check constraint refuses a mismatch and this module lets that
// throw, because the caller knows which setting it is writing and can refuse
// the caller's own value with a better answer than a constraint violation --
// which is what `commands/settings-write.ts` already does.
//
// **This function is the only writer that moves the revision.** Both settings
// commands write through it (`commands/settings-write.ts`). There is no
// trigger (0020 says why), so a statement that updated `business_settings`
// some other way would leave the revision where it was.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import type { WriteMode, VisibilityClass } from './fields.ts';

export type SettingValueType = 'numeric' | 'boolean' | 'text';

export interface SettingDefinition {
  readonly key: string;
  readonly label: string;
  readonly valueType: SettingValueType;
  /** Null is a real value here: the four-eyes band being off, a window unset. */
  readonly value: number | boolean | string | null;
  readonly writeMode: WriteMode;
  readonly owningOperations: readonly string[];
  readonly visibilityClass?: VisibilityClass;
}

/**
 * The named rows, and why each carries the mode it does.
 *
 * `four_eyes_threshold` and `client_sign_off_required` are owned by
 * operations: both change who has to agree before something happens, which is
 * an authority change wearing configuration's clothes — the same category of
 * field the task spine protects. The two windows are `generic`: they are
 * retention policy an administrator sets, and no transition depends on the
 * value being what it was a moment ago.
 */
export const BUSINESS_SETTINGS: readonly SettingDefinition[] = [
  {
    key: 'four_eyes_threshold',
    label: 'Second approver above',
    valueType: 'numeric',
    // Five hundred, from the accepted top-up rule. Null is "off", which the
    // rule permits explicitly, so the column is nullable in its json sense
    // rather than the row being absent.
    value: 500,
    writeMode: 'operation',
    owningOperations: ['settings.set_four_eyes_threshold'],
  },
  {
    key: 'client_sign_off_required',
    label: 'Client sign-off required',
    valueType: 'boolean',
    value: false,
    writeMode: 'operation',
    owningOperations: ['settings.set_client_sign_off'],
    // The client is told whether their sign-off is part of the process.
    visibilityClass: 'shared',
  },
  {
    key: 'retention_window_days',
    label: 'Retention window (days)',
    valueType: 'numeric',
    // Thirty days, the accepted default, with erasure's floor and ceiling
    // applied by the operation that reads it rather than by this row.
    value: 30,
    writeMode: 'generic',
    owningOperations: [],
  },
  {
    key: 'conversation_window_days',
    label: 'Conversation window (days)',
    valueType: 'numeric',
    value: 30,
    writeMode: 'generic',
    owningOperations: [],
  },
];

export interface BusinessSetting {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly valueType: SettingValueType;
  readonly value: number | boolean | string | null;
  readonly writeMode: WriteMode;
  readonly owningOperations: readonly string[];
  readonly visibilityClass: VisibilityClass;
  readonly updatedAt: Date;
  /** Null until a command has written it. Nobody owns a shipped default. */
  readonly updatedByActorId: string | null;
  /** What a write names to say which value it is replacing. Starts at 1 (0020). */
  readonly revision: number;
}

interface SettingRow {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly value_type: SettingValueType;
  readonly value: number | boolean | string | null;
  readonly write_mode: WriteMode;
  readonly owning_operation: readonly string[] | null;
  readonly visibility_class: VisibilityClass;
  readonly updated_at: Date;
  readonly updated_by_actor_id: string | null;
  readonly revision: number;
}

function settingFrom(row: SettingRow): BusinessSetting {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    valueType: row.value_type,
    value: row.value,
    writeMode: row.write_mode,
    owningOperations: row.owning_operation ?? [],
    visibilityClass: row.visibility_class,
    updatedAt: row.updated_at,
    updatedByActorId: row.updated_by_actor_id,
    revision: row.revision,
  };
}

/**
 * Put the named settings into this business, inside the caller's transaction.
 *
 * `on conflict do nothing` rather than an upsert: the key is unique per
 * business, so a second install adds what a later release named and leaves
 * every existing value where the business put it.
 */
export async function installBusinessSettings(tx: TenantQuery): Promise<void> {
  for (const setting of BUSINESS_SETTINGS) {
    // Sequential: one transaction, one connection, and a partial install is
    // worse than a slow one.
    // oxlint-disable-next-line no-await-in-loop
    await tx.query(
      `insert into business_settings
         (business_id, id, key, label, value_type, value, write_mode, owning_operation,
          visibility_class, origin)
       values ($1, $2, $3, $4, $5,
               case $5::text
                 when 'numeric' then
                   case when $6::text is null then 'null'::jsonb else to_jsonb($6::numeric) end
                 when 'boolean' then
                   case when $6::text is null then 'null'::jsonb else to_jsonb($6::boolean) end
                 else
                   case when $6::text is null then 'null'::jsonb else to_jsonb($6::text) end
               end,
               $7, $8, $9, 'core')
       on conflict do nothing`,
      [
        tx.businessId,
        randomUUID(),
        setting.key,
        setting.label,
        setting.valueType,
        // The value as plain text, converted by the server against the type
        // the row declares. Handing the driver a JSON document instead makes
        // the band the string "500", which no comparison reads, and the
        // check constraint is what caught that.
        setting.value === null ? null : String(setting.value),
        setting.writeMode,
        setting.owningOperations.length === 0 ? null : setting.owningOperations,
        setting.visibilityClass ?? 'internal',
      ],
    );
  }
}

export async function readBusinessSettings(tx: TenantQuery): Promise<readonly BusinessSetting[]> {
  const rows = await tx.query<SettingRow>(
    `select id, key, label, value_type, value, write_mode, owning_operation,
            visibility_class, updated_at, updated_by_actor_id, revision
       from business_settings
      where business_id = $1
      order by key`,
    [tx.businessId],
  );
  return rows.map(settingFrom);
}

/** One setting by key, or undefined when this business has none by that name. */
export async function readBusinessSetting(
  tx: TenantQuery,
  key: string,
): Promise<BusinessSetting | undefined> {
  const rows = await tx.query<SettingRow>(
    `select id, key, label, value_type, value, write_mode, owning_operation,
            visibility_class, updated_at, updated_by_actor_id, revision
       from business_settings
      where business_id = $1 and key = $2`,
    [tx.businessId, key],
  );
  const row = rows[0];
  return row === undefined ? undefined : settingFrom(row);
}

/**
 * The refusal a write against a revision the row has moved past gets.
 *
 * The records engine's shape, with the code the command register already holds
 * for this answer. It names the revision the row is actually at, which is
 * in-business configuration the caller is already inside the business to read,
 * and never the value the caller tried to write.
 */
export interface SettingRevisionStale {
  readonly refused: true;
  readonly code: 'VERSION_STALE';
  readonly names: readonly string[];
  readonly fixes: readonly string[];
}

/** The same wording the records spine uses, so a caller is told the same thing twice. */
export const SETTING_REVISION_FIXES: readonly string[] = [
  'Read the setting and send the revision you are writing against as expected_revision.',
  'A write against a stale revision is refused, never merged.',
];

/** The discriminant, so a caller can tell a written setting from a refusal. */
export function isSettingRevisionStale(value: object): value is SettingRevisionStale {
  return 'refused' in value && value.refused === true;
}

export interface BusinessSettingWrite {
  readonly key: string;
  /**
   * The value itself, not its text. The conversion is chosen from the type the
   * row declares and the server applies it; handing the driver a string for a
   * `numeric` makes the band the JSON string "500", which no comparison reads.
   */
  readonly value: number | boolean | string | null;
  /**
   * The revision the caller read. Absent means "write it anyway", which is what
   * a caller that has not learnt to send one does.
   */
  readonly expectedRevision?: number;
  /**
   * The operation writing, when a named one owns the row. The row itself says
   * which: `write_mode = 'operation'` and `owning_operation` naming this one.
   * Absent is a generic write, which an `operation` row refuses.
   */
  readonly owningOperation?: string;
  /** Who wrote it, recorded on the row. Never the caller's idea of who they are. */
  readonly actorId?: string | null;
}

export interface BusinessSettingWritten {
  readonly id: string;
  readonly key: string;
  readonly value: number | boolean | string | null;
  /** The revision the row is now at, which the next write names. */
  readonly revision: number;
}

/**
 * How a value becomes the document the row holds, by the type the row declares.
 *
 * Chosen here in TypeScript and not as a `case` over `value_type` in the
 * statement, for the reason `commands/settings-write.ts` records: the server
 * decides a parameter's type before the row is read, so every arm's cast is
 * folded at plan time and a numeric value is rejected by a boolean arm that was
 * never meant to run.
 *
 * Null is `'null'::jsonb` and not a SQL null: the column is `not null` and "the
 * band is off" is a value rather than an absence.
 */
const VALUE_SQL_BY_TYPE: Readonly<Record<SettingValueType, string>> = {
  numeric: `case when $3::text is null then 'null'::jsonb else to_jsonb($3::numeric) end`,
  boolean: `to_jsonb($3::boolean)`,
  text: `case when $3::text is null then 'null'::jsonb else to_jsonb($3::text) end`,
};

interface LockedSettingRow {
  readonly id: string;
  readonly value_type: SettingValueType;
  readonly write_mode: WriteMode;
  readonly owning_operation: readonly string[] | null;
  readonly revision: number;
}

/**
 * Write one setting, against the revision the caller read.
 *
 * **The row is locked before its revision is compared**, which is the whole
 * mechanism and the lesson `commands/prepare.ts` records for records: two
 * writers presenting the same revision each read the committed row, neither saw
 * the other's uncommitted write, and both applied -- so the one who lost was
 * told `applied` and the other's value was silently restored. Optimistic
 * concurrency is only as good as the row the comparison reads. With `for
 * update` the second transaction waits, re-reads the revision the first
 * committed, and is refused.
 *
 * The value and the revision then move in one statement, so there is no instant
 * in which the row holds a new value at an old revision.
 */
export async function writeBusinessSetting(
  tx: TenantQuery,
  write: BusinessSettingWrite,
): Promise<BusinessSettingWritten | SettingRevisionStale | undefined> {
  const locked = await tx.query<LockedSettingRow>(
    `select id, value_type, write_mode, owning_operation, revision
       from business_settings
      where business_id = $1 and key = $2
        for update`,
    [tx.businessId, write.key],
  );
  const row = locked[0];
  if (row === undefined) return undefined;

  // The row says which operation owns it, so a setting someone later
  // reclassified stops being writable by its old operation without this file
  // changing. A generic write to an `operation` row is the refusal the
  // classification exists for.
  const ownedElsewhere =
    write.owningOperation === undefined
      ? row.write_mode === 'operation'
      : row.write_mode !== 'operation' ||
        !(row.owning_operation ?? []).includes(write.owningOperation);
  if (ownedElsewhere) return undefined;

  if (write.expectedRevision !== undefined && write.expectedRevision !== row.revision) {
    return {
      refused: true,
      code: 'VERSION_STALE',
      names: [`revision=${row.revision}`],
      fixes: SETTING_REVISION_FIXES,
    };
  }

  const written = await tx.query<{
    readonly id: string;
    readonly key: string;
    readonly value: number | boolean | string | null;
    readonly revision: number;
  }>(
    `update business_settings
        set value = ${VALUE_SQL_BY_TYPE[row.value_type]},
            revision = revision + 1,
            updated_at = now(),
            updated_by_actor_id = $4
      where business_id = $1 and key = $2
    returning id, key, value, revision`,
    [tx.businessId, write.key, write.value ?? null, write.actorId ?? null],
  );
  // The row was locked above, so the update reaches it or the transaction is
  // not the one holding the lock, which cannot happen inside one statement.
  return written[0];
}
