// SPDX-License-Identifier: AGPL-3.0-only
//
// The one preference store (MP-2-11a): a person's own keys, one row each in
// `person_preferences`. Every function takes the person whose row it reaches;
// the command passes the caller, so there is no way to name someone else.
//
// The keys are closed: a key not in `PREFERENCE_KEYS` is refused, and each key
// admits one value shape. The widths are reserved here for the parts that
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
  'appearance' | 'rail.width' | 'dock.width' | 'dock.sheetHeight' | 'columns.widths';

export const PREFERENCE_KEYS: { readonly [K in PreferenceKey]: (value: unknown) => boolean } = {
  /** Light, Dark or System; the default, System, is the absence of a row. */
  appearance: (value) => value === 'light' || value === 'dark' || value === 'system',
  'rail.width': isLength,
  'dock.width': isLength,
  'dock.sheetHeight': isLength,
  /** One width per column id. */
  'columns.widths': isColumnWidths,
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
