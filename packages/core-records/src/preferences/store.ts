// SPDX-License-Identifier: AGPL-3.0-only
//
// The one preference store (MP-2-11a): a person's own keys, one row each in
// `person_preferences`. Every function takes the person whose row it reaches;
// the command passes the caller, so there is no way to name someone else.
//
// The keys are closed: a key not in `PREFERENCE_KEYS` is refused, and each key
// admits one value shape. The guided tips (MP-2-11) are two keys: a save of
// `tips.dismissed` takes only `{}`, which is the reset, and a dismissal is
// merged into it by `dismissTip` alone. The widths are reserved here for the parts that
// draw them (MP-2-3 the rail, MP-3-2 the dock, MP-5-6 the columns), which may
// narrow their bounds; none of them adds a table.

import type { TenantQuery } from '../tenancy/database.ts';

/** A width or height in CSS pixels: a whole number no screen exceeds. */
const isLength = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 10_000;

const isColumnWidths = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((width) => isLength(width));

export type PreferenceKey =
  | 'appearance'
  | 'rail.width'
  | 'rail.collapsed'
  | 'dock.width'
  | 'dock.sheetHeight'
  | 'columns.widths'
  | 'tips.enabled'
  | 'tips.dismissed';

export const PREFERENCE_KEYS: { readonly [K in PreferenceKey]: (value: unknown) => boolean } = {
  /** Light, Dark or System; the default, System, is the absence of a row. */
  appearance: (value) => value === 'light' || value === 'dark' || value === 'system',
  'rail.width': isLength,
  /** The rail folded to its icon strip (MP-2-3); open, the default, is false or no row. */
  'rail.collapsed': (value) => typeof value === 'boolean',
  'dock.width': isLength,
  'dock.sheetHeight': isLength,
  /** One width per column id. */
  'columns.widths': isColumnWidths,
  /** Guided tips on or off; on, the default, is the absence of a row. */
  'tips.enabled': (value) => typeof value === 'boolean',
  /** Only the reset: every dismissal is brought back at once. */
  'tips.dismissed': (value) =>
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0,
};

export function isPreferenceKey(key: string): key is PreferenceKey {
  return Object.hasOwn(PREFERENCE_KEYS, key);
}

/** Whether `value` is one `key` takes. An unknown key takes nothing. */
export function admitsPreference(key: string, value: unknown): boolean {
  return isPreferenceKey(key) && PREFERENCE_KEYS[key](value);
}

/** Write `key` on `personId`'s own row, replacing a value saved before. */
export async function savePreference(
  tx: TenantQuery,
  personId: string,
  key: PreferenceKey,
  value: unknown,
): Promise<void> {
  await tx.query(
    `insert into public.person_preferences (business_id, person_id, key, value)
     values ($1, $2, $3, $4::text::jsonb)
     on conflict (business_id, person_id, key)
       do update set value = excluded.value, saved_at = now()`,
    [tx.businessId, personId, key, JSON.stringify(value)],
  );
}

/**
 * Merge one dismissal into `personId`'s own `tips.dismissed`, in one statement:
 * the upsert takes the row's lock and merges into the value it finds there, so
 * a dismissal made at the same moment on another device is kept, never
 * overwritten. A tip not already held is refused past `limit` tips. Whether it
 * was written.
 */
export async function dismissTip(
  tx: TenantQuery,
  personId: string,
  entry: string,
  version: number,
  limit: number,
): Promise<boolean> {
  const rows = await tx.query(
    `insert into public.person_preferences as p (business_id, person_id, key, value)
     values ($1, $2, 'tips.dismissed', jsonb_build_object($3::text, $4::int))
     on conflict (business_id, person_id, key)
       do update set value = p.value || excluded.value, saved_at = now()
       where p.value ? $3::text
          or (select count(*) from jsonb_object_keys(p.value)) < $5
     returning 1`,
    [tx.businessId, personId, entry, version, limit],
  );
  return rows.length === 1;
}

/** `personId`'s saved keys. A key never saved is absent, not defaulted. */
export async function readPreferences(
  tx: TenantQuery,
  personId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const rows = await tx.query<{ readonly key: string; readonly value: unknown }>(
    `select key, value from public.person_preferences
      where business_id = $1 and person_id = $2
      order by key`,
    [tx.businessId, personId],
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}
