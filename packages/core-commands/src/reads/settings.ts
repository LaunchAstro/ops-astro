// SPDX-License-Identifier: AGPL-3.0-only
//
// The business's own settings, as a caller is shown them.
//
// Four landed contracts name a per-business setting — the four-eyes band, the
// retention window, the conversation window and the client sign-off
// requirement — and until this read there was no surface that could show one.
// A value that decides who must agree before money moves, held where only a
// migration and two commands could see it, is a business fact the business
// cannot check.
//
// **The revision is here, and it is the number a write sends back.** 0020 gave
// `business_settings` a `revision` column and `records/business-settings.ts`
// compares it under a row lock, so a caller reads a setting, writes against
// the revision it read, and is refused rather than merged when the row has
// moved on. A projection that dropped the number would have left the client no
// way to name what it was replacing, which is the whole of the check.
//
// **`writeMode`, `label`, `visibilityClass` and the row id are not here.**
// The contract asks for the value and its provenance; the classification is
// what the *server* decides a generic edit against, and echoing it would
// invite a client to decide the same question for itself.

import { readBusinessSettings } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { SettingView } from '../../../core-wire/src/index.ts';

/**
 * Every setting this business holds, ordered by key.
 *
 * One statement: the values, types, times and authors all come from
 * `readBusinessSettings`, so a value and the actor shown as its author are
 * from the same commit. A second read for the author, joined by key, could
 * pair them across two (thermo review b483399, L3).
 */
export async function readSettings(tx: TenantQuery): Promise<readonly SettingView[]> {
  const settings = await readBusinessSettings(tx);
  return settings.map((setting) => ({
    key: setting.key,
    value: setting.value,
    valueType: setting.valueType,
    updatedAt: setting.updatedAt.toISOString(),
    updatedByActorId: setting.updatedByActorId,
    revision: setting.revision,
  }));
}
