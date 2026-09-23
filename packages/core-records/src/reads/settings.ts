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
// **There is no revision.** `business_settings` carries `updated_at` and
// `updated_by_actor_id` and no revision column, so this projection has nothing
// to be stale against and carries no `revision` field for a caller to send
// back. That is a schema gap rather than a decision, recorded as one: the
// column is queued for L4-RUNTIME-FIX, and inventing a number here would let a
// client believe in an optimistic-concurrency check the server cannot make.
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
  }));
}
