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

import type { TenantQuery } from '../tenancy/database.ts';
import { readBusinessSettings, type SettingValueType } from '../records/business-settings.ts';

/**
 * One setting, projected.
 *
 * `updatedAt` is an ISO string rather than a `Date` because every other time
 * on this surface is (`TaskSummary.due`, `HistoryEntry.at`): one read handing
 * back a `Date` and the next a string is the difference a client discovers in
 * production.
 */
export interface SettingView {
  readonly key: string;
  readonly value: number | boolean | string | null;
  /** `numeric`, `boolean` or `text`, as the row declares it. */
  readonly valueType: SettingValueType;
  readonly updatedAt: string;
  /** Null until a command has written it. Nobody owns a shipped default. */
  readonly updatedByActorId: string | null;
  /**
   * What a write names to say which value it is replacing. Starts at 1, and a
   * command that sends a number the row has moved past is refused
   * `VERSION_STALE` rather than having its value merged over the winner's.
   */
  readonly revision: number;
}

/**
 * Every setting this business holds, ordered by key.
 *
 * The values, types and times come from `records/business-settings.ts`
 * unchanged; the author does not, because `BusinessSetting` does not carry it
 * and that module belongs to L2 rather than to this lane. So the author is
 * read in one extra projection and joined by key, which is the narrow half of
 * the row and nothing else. Widening `readBusinessSettings` to carry it is the
 * better fix and it is a change to somebody else's file.
 */
export async function readSettings(tx: TenantQuery): Promise<readonly SettingView[]> {
  const settings = await readBusinessSettings(tx);
  const authors = await tx.query<{
    readonly key: string;
    readonly updated_by_actor_id: string | null;
  }>(`select key, updated_by_actor_id from business_settings where business_id = $1`, [
    tx.businessId,
  ]);
  const authorOf = new Map(authors.map((row) => [row.key, row.updated_by_actor_id]));
  return settings.map((setting) => ({
    key: setting.key,
    value: setting.value,
    valueType: setting.valueType,
    updatedAt: setting.updatedAt.toISOString(),
    updatedByActorId: authorOf.get(setting.key) ?? null,
    revision: setting.revision,
  }));
}
