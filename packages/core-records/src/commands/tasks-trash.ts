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
import { fromRecords } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';

const DAY = 24 * 60 * 60 * 1000;

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
 * The window is a number of days rather than a configured setting so a test
 * can set it to nothing and watch the operation accept the work class and
 * refuse the evidence class in one run — which is what specification 14.3 says
 * the first slice builds instead of a timed sweep nobody can watch.
 */
export async function purgeTasks(
  tx: TenantQuery,
  context: CommandContext,
  olderThanDays: number,
): Promise<HandlerOutcome> {
  const purged = await purgeTrashedRecords(tx, {
    recordTypeId: context.spine.taskTypeId,
    trashedBefore: new Date(Date.now() - olderThanDays * DAY),
  });
  if (isRecordsRefusal(purged)) return refused(fromRecords(purged));
  return applied(null, null, { purged: purged.recordIds.length });
}
