// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's delete (#2345), wrapped as a command. It is the bin
// (`tasks-trash.ts`) asked under `decide`, with one more refusal in front of
// the write: a subtree with money, run or client history is closed instead.

import {
  conversationsPagedTo,
  isRecordsRefusal,
  slotOf,
  trashSubtree,
  TASK_SPINE,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';
import { refuseUnreached, revisionOf } from './tasks-trash.ts';

/**
 * A person's delete (#2345): the bin, asked under `decide`, for a subtree with
 * no history worth keeping in view. The rows stay either way; what this
 * refuses is hiding money, a run or a client's task behind a bin nobody
 * looks in. Those are closed instead, and stay where they can be seen.
 */
export async function deleteTask(
  tx: TenantQuery,
  context: CommandContext,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('deleteTask: the envelope read no target');
  const deleted = await trashSubtree(tx, {
    rootId: target.id,
    actorId: context.session.actorId,
    authorise: async (recordIds: readonly string[]) =>
      (await refuseUnreached(tx, context, target.id, recordIds)) ??
      (await refuseHistory(tx, recordIds)),
  });
  if ('denied' in deleted) return refused(deleted.denied);
  if (isRecordsRefusal(deleted)) return refused(deleted);
  return applied(target.id, await revisionOf(tx, target.id), {
    batchId: deleted.batchId,
    deleted: deleted.recordIds.length,
  });
}

const CLIENT = slotOf(TASK_SPINE, 'client');
const CLIENT_VISIBLE = slotOf(TASK_SPINE, 'client_visible');

/**
 * Whether any task in the walk carries what a delete must not hide: proposed
 * or approved work, money held or spent (every hold, spend and model call
 * hangs off a task's envelope, lease or run), a launch, a planning envelope
 * or model call on a conversation naming it (by scope, or by its added page,
 * as `pageTaskOf` resolves it), or a client link, review or live correction.
 *
 * Asked after the walk is locked `for update`, read committed. Each of those
 * rows except a conversation's names its task by a foreign key, whose check
 * waits on that lock, so one written before this read is seen here, and one
 * written after waits for the delete and then lands on a task already in the
 * bin, as it would after `task.trash`. Nothing is removed either way.
 */
async function refuseHistory(
  tx: TenantQuery,
  recordIds: readonly string[],
): Promise<CommandRefusal | undefined> {
  const paged = await conversationsPagedTo(tx, recordIds, { lock: false });
  const rows = await tx.query<{ readonly work: boolean; readonly client: boolean }>(
    `with talks as (
       select id from conversations
        where business_id = $1 and (scope_record_id = any ($2::uuid[]) or id = any ($3::uuid[]))
     )
     select
       exists (select 1 from proposal_lineages where business_id = $1 and task_id = any ($2::uuid[]))
       or exists (select 1 from task_envelopes where business_id = $1 and task_id = any ($2::uuid[]))
       or exists (select 1 from planned_runs where business_id = $1 and task_id = any ($2::uuid[]))
       or exists (select 1 from leases where business_id = $1 and task_id = any ($2::uuid[]))
       or exists (select 1 from task_launches where business_id = $1 and task_id = any ($2::uuid[]))
       or exists (select 1 from planning_envelopes
                   where business_id = $1 and conversation_id in (select id from talks))
       or exists (select 1 from model_calls
                   where business_id = $1 and conversation_id in (select id from talks)) as work,
       exists (select 1 from records where business_id = $1 and id = any ($2::uuid[])
                 and (${CLIENT} is not null or ${CLIENT_VISIBLE} is true))
       or exists (select 1 from reviews where business_id = $1 and task_id = any ($2::uuid[]))
       or exists (select 1 from live_corrections where business_id = $1 and task_id = any ($2::uuid[]))
         as client`,
    [tx.businessId, recordIds, paged],
  );
  const found = rows[0];
  if (found?.work === true) {
    return refuseCommand(
      'TASK_NOT_DELETABLE',
      ['work'],
      [
        'This task or a subtask has money or run history: a hold, envelope, spend, model call, run or launch.',
        'Cancel its run instead, or complete the task. Its history stays with it.',
      ],
    );
  }
  if (found?.client === true) {
    return refuseCommand(
      'TASK_NOT_DELETABLE',
      ['client'],
      [
        'This task or a subtask is linked to a client.',
        'Complete it instead. Its history stays with it.',
      ],
    );
  }
  return undefined;
}
