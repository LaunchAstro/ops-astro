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
import { checkAuthority, subjectsOf } from '../authority/grants.ts';
import {
  fromReasoned,
  fromRecords,
  refuseCommand,
  type CommandRefusal,
  type ReasonedRefusal,
} from './refusal.ts';
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
    authorise: async (recordIds: readonly string[]) =>
      await refuseUnreached(tx, context, target.id, recordIds),
  });
  if ('denied' in trashed) return refused(fromReasoned(trashed.denied));
  if (isRecordsRefusal(trashed)) return refused(fromRecords(trashed));
  // Trashing writes `deleted_at`, so the revision moved. The handle carries
  // the new one: a caller that has to guess it would be refused
  // `VERSION_STALE` for doing the next honest thing.
  return applied(target.id, await revisionOf(tx, target.id), {
    batchId: trashed.batchId,
    trashed: trashed.recordIds.length,
  });
}

/**
 * The envelope asked the declaration's authority on the root only. Every
 * descendant the walk found is asked the same question at its own record
 * scope, because a record-scoped grant matches its own record and no other
 * (`authority/grants.ts`; R3, `core-runtime/src/propose.ts`). One business
 * grant answers for all of them, so that is asked first. The first
 * uncovered descendant refuses the whole trash with the authority refusal as
 * it stands: no count and no name of what is below.
 */
async function refuseUnreached(
  tx: TenantQuery,
  context: CommandContext,
  rootId: string,
  recordIds: readonly string[],
): Promise<ReasonedRefusal | undefined> {
  const descendants = recordIds.filter((id) => id !== rootId);
  if (descendants.length === 0) return undefined;
  const subjects = subjectsOf(context.session);
  const { collection, action } = context.declaration;
  const whole = await checkAuthority(tx, subjects, {
    collection,
    action,
    scope: { kind: 'business', id: null },
  });
  if (whole.ok) return undefined;
  for (const id of descendants) {
    // Sequential, and stopping at the first uncovered record: the answer is
    // the same refusal whichever one it is.
    // eslint-disable-next-line no-await-in-loop
    const reached = await checkAuthority(tx, subjects, {
      collection,
      action,
      scope: { kind: 'record', id },
    });
    if (!reached.ok) return reached.refusal;
  }
  return undefined;
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
  // The ids go in the stored result: the event this command writes has one
  // subject column and a restore has no single subject (R2-RUNTIME-55).
  return applied(null, null, {
    batchId,
    restored: restored.recordIds.length,
    restoredIds: restored.recordIds,
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
  const trashedBefore = await cutoff(tx, window);
  const purged =
    trashedBefore === undefined
      ? { recordIds: [], retainedIds: [], commentIds: [], grantsRevoked: 0 }
      : await purgeTrashedRecords(tx, {
          recordTypeId: context.spine.taskTypeId,
          trashedBefore,
          commentTypeId: context.spine.taskCommentTypeId,
        });
  if (isRecordsRefusal(purged)) return refused(fromRecords(purged));
  // `retained` names the aged trash the runtime still holds, so the stored
  // result says what the purge kept as well as how much it removed. The
  // destroyed ids are named too: after the purge, this result is the only
  // place that says they existed (R2-RUNTIME-55).
  return applied(null, null, {
    purged: purged.recordIds.length,
    purgedIds: purged.recordIds,
    retained: purged.retainedIds,
    commentsPurged: purged.commentIds.length,
    grantsRevoked: purged.grantsRevoked,
  });
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
 * A window this long reaches back past 3400 BC, well inside the database's
 * calendar (which starts at 4713 BC) and far before any `deleted_at` it holds.
 */
const LONGEST_COMPUTED_WINDOW_DAYS = 2_000_000;

/**
 * The moment trash has to be older than, on the database's clock.
 *
 * `now()` is the transaction's start, so a row trashed by any earlier
 * transaction is before it even at a window of zero, and the cutoff and the
 * `deleted_at` it is compared with come from one clock.
 *
 * The window has no ceiling, so a longer one than the calendar holds is
 * answered as what it means, nothing is old enough, rather than handed to
 * date arithmetic that overflows and faults the purge (R2-SURFACE-66).
 */
async function cutoff(tx: TenantQuery, days: number): Promise<Date | undefined> {
  if (days > LONGEST_COMPUTED_WINDOW_DAYS) return undefined;
  const rows = await tx.query<{ readonly cutoff: Date }>(
    `select now() - make_interval(days => $1::int) as cutoff`,
    [days],
  );
  const at = rows[0]?.cutoff;
  if (at === undefined) throw new Error('purgeTasks: the database answered no time');
  return at;
}
