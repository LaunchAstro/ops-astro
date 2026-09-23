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
            visibility_class, updated_at
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
            visibility_class, updated_at
       from business_settings
      where business_id = $1 and key = $2`,
    [tx.businessId, key],
  );
  const row = rows[0];
  return row === undefined ? undefined : settingFrom(row);
}
