// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7: what starting a research run asks, and the claim it writes. Called by
// `task.propose` (`tasks-propose.ts`) under the task lock, in its transaction.

import { checkAuthority, checkDelegatedAuthority } from '../../../core-records/src/index.ts';
import type { Delegation, Subject, TenantQuery } from '../../../core-records/src/index.ts';
import type { TaskRow } from './context.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';

/**
 * The research checks, in order: `run:write` (`researchRunRefusal`), then a
 * claim held by someone else, then `task:assign` where the start would write
 * the claim (ORCH36-WF7-ASSIGN). Asked before the revision, so a starter who
 * lost the race is told it is claimed.
 */
export async function researchStartRefusal(
  tx: TenantQuery,
  ticket: TaskRow,
  subjects: readonly Subject[],
  delegation: Delegation | undefined,
  starter: string,
): Promise<CommandRefusal | undefined> {
  const refusal = await researchRunRefusal(tx, ticket.id, subjects, delegation);
  if (refusal !== undefined) return refusal;
  if (claimedByAnother(ticket, starter)) {
    return refuseCommand('TRANSITION_NOT_PERMITTED', ['claimed'], [CLAIMED_FIX]);
  }
  // Writing the claim asks what `task.claim` asks.
  if (!isSet(ticket.data['assignee']) && !(await mayAssign(tx, ticket.id, subjects))) {
    return refuseCommand('SCOPE_NOT_GRANTED', ['task:assign'], [ASSIGN_FIX]);
  }
  return undefined;
}

/** The ticket's revision after the start: claimed for the starter if no one held it. */
export async function claimUnclaimed(
  tx: TenantQuery,
  ticket: TaskRow,
  starter: string,
): Promise<number> {
  return isSet(ticket.data['assignee']) ? ticket.revision : await claimFor(tx, ticket.id, starter);
}

/**
 * WF-7: Run on a research ticket starts a research run, which is `run:write`
 * on the ticket beside the row's `task:write`. An agent reaches it only where
 * its delegation does (MP-6-2 mints `run` for a person holding it), and never
 * past its person's grants. Asked under the task lock, as the runtime asks.
 */
async function researchRunRefusal(
  tx: TenantQuery,
  taskId: string,
  subjects: readonly Subject[],
  delegation: Delegation | undefined,
): Promise<CommandRefusal | undefined> {
  const request = {
    collection: 'run',
    action: 'write',
    scope: { kind: 'record', id: taskId },
  } as const;
  if (delegation !== undefined) {
    const reach = await checkDelegatedAuthority(tx, delegation, request);
    if (!reach.ok) return reach.refusal;
  }
  if ((await checkAuthority(tx, subjects, request)).ok) return undefined;
  return refuseCommand('SCOPE_NOT_GRANTED', ['run:write'], [RUN_WRITE_FIX]);
}

const RUN_WRITE_FIX = 'Starting a research run needs run:write on the ticket; ask for it.';
const CLAIMED_FIX = 'Someone else has claimed this ticket; its run is theirs to start.';
const ASSIGN_FIX =
  'Starting the run claims the ticket, which needs task:assign; ask for it, or for the claim.';

const mayAssign = async (tx: TenantQuery, taskId: string, subjects: readonly Subject[]) =>
  (
    await checkAuthority(tx, subjects, {
      collection: 'task',
      action: 'assign',
      scope: { kind: 'record', id: taskId },
    })
  ).ok;

const isSet = (value: unknown): boolean => value !== undefined && value !== null;

/** Held by a person other than the starter, or by an agent. */
function claimedByAnother(ticket: TaskRow, starter: string): boolean {
  const assignee = ticket.data['assignee'];
  return (isSet(assignee) && assignee !== starter) || isSet(ticket.data['delegate']);
}

/** The claim `task.claim` writes, in the proposal's transaction under its lock. */
async function claimFor(tx: TenantQuery, taskId: string, starter: string): Promise<number> {
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = data || jsonb_build_object('assignee', $3::uuid), updated_at = now()
      where business_id = $1 and id = $2 returning revision::text as revision`,
    [tx.businessId, taskId, starter],
  );
  return Number(rows[0]?.revision);
}
