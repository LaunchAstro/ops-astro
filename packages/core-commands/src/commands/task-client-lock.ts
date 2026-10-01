// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: a task's client is locked once the task has content (owner line 75).
//
// `task.set_party` changes the client only while the task is empty: its history
// holds nothing beyond its creation and earlier client changes, and no row
// names it (a subtask naming it as parent, a proposal, a planned run, an envelope,
// a lease, an alert). The check runs under the task's row lock, which the
// preparation took (`lockTask`, `for update`), so a content write that holds
// the same lock is either wholly before it or wholly after it.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { COMMAND_SURFACE } from '../../../core-wire/src/index.ts';
import type { CommandContext } from './context.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { FieldValues } from './requests.ts';
import { setParty } from './tasks-party.ts';
import { writeOwnedFields } from './tasks-state.ts';

/** Writes whose history event is content; creation and client changes are not. */
const CONTENT_COMMANDS: readonly string[] = COMMAND_SURFACE.filter(
  (declaration) =>
    declaration.kind === 'write' && !['task.create', 'task.set_party'].includes(declaration.name),
).map((declaration) => declaration.name);

const LOCKED_FIXES: readonly string[] = [
  'This task has content, so its client is locked.',
  'Duplicate it without contents to start one for another client.',
];

async function hasContent(tx: TenantQuery, taskId: string): Promise<boolean> {
  const [row] = await tx.query<{ readonly content: boolean }>(
    `select exists (select 1 from audit_events where business_id = $1 and subject_record_id = $2
                      and outcome = 'applied' and command = any($3::text[]))
         or exists (select 1 from records r where r.business_id = $1 and r.uuid_4 = $2
                      and r.record_type_id = (select record_type_id from records where id = $2))
         or exists (select 1 from proposal_lineages where business_id = $1 and task_id = $2)
         or exists (select 1 from planned_runs where business_id = $1 and task_id = $2)
         or exists (select 1 from task_envelopes where business_id = $1 and task_id = $2)
         or exists (select 1 from leases where business_id = $1 and task_id = $2)
         or exists (select 1 from alerts where business_id = $1 and task_id = $2) as content`,
    [tx.businessId, taskId, CONTENT_COMMANDS],
  );
  return row?.content !== false;
}

/**
 * The client change, refused `CLIENT_LOCKED` and writing nothing once the task
 * has content. An empty task's change is MP-4-4's (`setParty`): a subtask is
 * held to its parent's client, and a parent's client carries down (a parent
 * with a subtask has content, so the lock answers first there).
 */
export async function setPartyWhileEmpty(
  tx: TenantQuery,
  context: CommandContext,
  fields: FieldValues,
): Promise<HandlerOutcome> {
  // A trashed task keeps its old answer (`NOT_FOUND`, from the owned-field writer).
  const task = context.target;
  if (task === undefined || task.deleted_at !== null) {
    return await writeOwnedFields(tx, context, 'task.set_party', fields);
  }
  if (await hasContent(tx, task.id)) {
    return refused(refuseCommand('CLIENT_LOCKED', [], LOCKED_FIXES));
  }
  return await setParty(tx, context, fields);
}
