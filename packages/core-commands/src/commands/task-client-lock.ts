// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: a task's client is locked once the task has content (owner line 75).
//
// `task.set_party` changes the client only while the task is empty: its history
// holds nothing beyond its creation and earlier client changes, and no row
// names it (a subtask naming it as parent, a proposal, a planned run, an envelope,
// a lease, an alert, a time entry, deleted or not). A time event names no
// subject (RS-VAULT-9), so the entry's row is what the lock reads. A tag event
// keeps the task as its subject: a removed tag leaves no row behind. The check
// runs under the task's row lock, which the preparation took (`lockTask`,
// `for update`), so a content write that holds the same lock is either wholly
// before it or wholly after it.
//
// Not every content write takes the task lock. The runtime's own (heartbeat,
// dispatch, observe) lock runtime rows, but each runs only on a task that
// already holds a lineage, a planned run, a lease and a reservation, and
// `task.propose` wrote the first of those under the task lock. Their history
// rows are counted below all the same; they can never be a task's first content.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import type { FieldValues } from './requests.ts';
import { setParty } from './tasks-party.ts';
import { hasContent } from './task-content.ts';
import { writeOwnedFields } from './tasks-state.ts';

const LOCKED_FIXES: readonly string[] = [
  'This task has content, so its client is locked.',
  'Duplicate it without contents to start one for another client.',
];

/**
 * The client change, refused `CLIENT_LOCKED` and writing nothing once the task
 * has content. An empty task's change is MP-4-4's (`setParty`): a subtask is
 * held to its parent's client. A parent with a live subtask has content, so
 * the lock answers first and `setParty`'s carry-down is not reached from here.
 */
export async function setPartyWhileEmpty(
  tx: TenantQuery,
  context: CommandContext,
  fields: FieldValues,
): Promise<HandlerOutcome> {
  // A trashed task keeps its old answer (`NOT_FOUND`, from the owned-field writer).
  const task = context.target;
  if (task !== undefined && task.deleted_at !== null) {
    return await writeOwnedFields(tx, context, 'task.set_party', fields);
  }
  if (task !== undefined && (await hasContent(tx, task.id))) {
    return refused(refuseCommand('CLIENT_LOCKED', [], LOCKED_FIXES));
  }
  return await setParty(tx, context, fields);
}
