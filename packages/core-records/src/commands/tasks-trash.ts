// SPDX-License-Identifier: AGPL-3.0-only
//
// Trash, restore and purge, wrapped as commands.
//
// The operations themselves are T1e's and are not repeated here. What this
// file adds is the thing T1e handed on: "the purge writes no audit event, and
// 14.3 requires one. `audit_events` is T1f's table. All three of trash,
// restore and purge return the identifiers they touched so the command can
// write the event. T1f owes these."
//
// So each of the three is a command, which means each one goes through the
// envelope: an operation identity, an authority check, and an audit event
// naming what it touched. The purge additionally needs `manage` rather than
// `write`, because destroying a record is not editing one.

import type { TenantQuery } from '../tenancy/database.ts';
import { isRecordsRefusal } from '../records/refusals.ts';
import { purgeTrashedRecords, restoreBatch, trashSubtree } from '../tasks/trash.ts';
import { readBusinessSetting } from '../records/business-settings.ts';
import { fromRecords, refuseCommand, type CommandRefusal } from './refusal.ts';
import { refusePurgeOperands, refuseRestoreOperands } from './operands.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';

async function revisionOf(tx: TenantQuery, recordId: string): Promise<number | null> {
  const rows = await tx.query<{ readonly revision: string }>(
    `select revision::text as revision from records where business_id = $1 and id = $2`,
    [tx.businessId, recordId],
  );
  const revision = rows[0]?.revision;
  return revision === undefined ? null : Number(revision);
}

export async function trashTask(tx: TenantQuery, context: CommandContext): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('trashTask: the envelope read no target');
  const trashed = await trashSubtree(tx, {
    rootId: target.id,
    actorId: context.session.actorId,
  });
  if (isRecordsRefusal(trashed)) return refused(fromRecords(trashed));
  // Trashing writes `deleted_at`, so the revision moved. The handle carries
  // the new one: a caller that has to guess it would be refused
  // `VERSION_STALE` for doing the next honest thing.
  return applied(target.id, await revisionOf(tx, target.id), {
    batchId: trashed.batchId,
    trashed: trashed.recordIds.length,
  });
}

export async function restoreTasks(
  tx: TenantQuery,
  _context: CommandContext,
  batchId: string,
): Promise<HandlerOutcome> {
  const operands = refuseRestoreOperands(batchId);
  if (operands !== undefined) return refused(operands);
  const restored = await restoreBatch(tx, { batchId });
  if (isRecordsRefusal(restored)) return refused(fromRecords(restored));
  return applied(null, null, {
    batchId,
    restored: restored.recordIds.length,
  });
}

/**
 * The purge, and the refusal that makes the retention classes real.
 *
 * The window is the business's own `retention_window_days`, read here inside
 * the transaction the command is served in, so it is always the caller's
 * business's row and never a number the caller sent. Specification 14.3 purges
 * the work class "after the business's retention window", and SPEC:319 with
 * C12-5 Q46 moved that window out of this request body and into the settings
 * table (root ruling 2, L3-RETENTION). It is still configurable, which is what
 * 14.3 asks of it: a test sets the row to zero and watches the operation accept
 * the work class and refuse the evidence class in one run.
 *
 * A body that still names `olderThanDays` is refused rather than ignored
 * (`refusePurgeOperands`): a caller whose override was quietly dropped believes
 * it purged what it asked for.
 */
export async function purgeTasks(
  tx: TenantQuery,
  context: CommandContext,
  olderThanDays: unknown,
): Promise<HandlerOutcome> {
  const operands = refusePurgeOperands(olderThanDays);
  if (operands !== undefined) return refused(operands);
  const window = await retentionWindowDays(tx);
  if (typeof window !== 'number') return refused(window);
  const purged = await purgeTrashedRecords(tx, {
    recordTypeId: context.spine.taskTypeId,
    trashedBefore: await cutoff(tx, window),
  });
  if (isRecordsRefusal(purged)) return refused(fromRecords(purged));
  return applied(null, null, { purged: purged.recordIds.length });
}

const RETENTION_WINDOW = 'retention_window_days';

/**
 * The stored window, or the refusal for a business that has none to read.
 *
 * No default, floor or ceiling is applied here: no accepted source names one
 * for the work window (the seven-day floor of C122-1 is the conversation
 * window's), so a missing row is `NOT_FOUND`, the answer `records/business-
 * settings.ts` leaves its callers for a key the business has no row for, and a
 * row that is not a whole number of days, zero or more, is refused with the
 * bound the request operand carried before it moved here.
 */
async function retentionWindowDays(tx: TenantQuery): Promise<number | CommandRefusal> {
  const setting = await readBusinessSetting(tx, RETENTION_WINDOW);
  if (setting === undefined) {
    return refuseCommand(
      'NOT_FOUND',
      [RETENTION_WINDOW],
      ['This business has no retention window to purge by; install its business settings.'],
    );
  }
  const days = setting.value;
  if (typeof days === 'number' && Number.isSafeInteger(days) && days >= 0) return days;
  return refuseCommand(
    'FIELD_VALUE_INVALID',
    [RETENTION_WINDOW],
    ['Set retention_window_days to a whole number of days, zero or more.'],
  );
}

/**
 * The moment trash has to be older than, on the database's clock.
 *
 * `now()` is the transaction's start, so a row trashed by any earlier
 * transaction is before it even at a window of zero, and the cutoff and the
 * `deleted_at` it is compared with come from one clock.
 */
async function cutoff(tx: TenantQuery, days: number): Promise<Date> {
  const rows = await tx.query<{ readonly cutoff: Date }>(
    `select now() - make_interval(days => $1::int) as cutoff`,
    [days],
  );
  const at = rows[0]?.cutoff;
  if (at === undefined) throw new Error('purgeTasks: the database answered no time');
  return at;
}
