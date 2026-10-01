// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7: what starting a research run asks, and the claim it writes. Called by
// `task.propose` (`tasks-propose.ts`) under the task lock, in its transaction,
// and by `task.restart` (`researchRestartRefusal`). The stop is asked again
// wherever a run begins another way: `task.decide` and `task.pickup`.

import {
  checkAuthority,
  checkDelegatedAuthority,
  subjectsOf,
  wayfinderFacts,
} from '../../../core-records/src/index.ts';
import type { Delegation, Session, Subject, TenantQuery } from '../../../core-records/src/index.ts';
import type { TaskRow } from './context.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { clearAsk, failedTwice, openAsk, researchLifted } from './research-failed.ts';
import { pinResearchSkillOnStart } from './research-skill.ts';

/**
 * The research checks, in order: `run:write` (`researchRunRefusal`), then a
 * stop (`stopRefusal`: a start that lifts it is that person's decision, past
 * another's claim), then a claim
 * held by someone else, then `task:assign` where the start would write the
 * claim (ORCH36-WF7-ASSIGN). Asked before the revision, so a starter who lost
 * the race is told it is claimed.
 */
export async function researchStartRefusal(
  tx: TenantQuery,
  ticket: TaskRow,
  subjects: readonly Subject[],
  delegation: Delegation | undefined,
  starter: string,
  actorId: string,
): Promise<CommandRefusal | undefined> {
  const refusal = await researchRunRefusal(tx, ticket.id, subjects, delegation);
  if (refusal !== undefined) return refusal;
  const lifts = await isStopped(tx, ticket.id);
  const stopped = await stopRefusal(tx, ticket.id, { personId: starter, actorId });
  if (stopped !== undefined) return stopped;
  if (!lifts && claimedByAnother(ticket, starter)) {
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

/** Whose word begins a run: the proposer, the restarter, the approver. */
export interface Starter {
  readonly personId: string;
  readonly actorId: string;
}

/**
 * WF-7 twice failed, it stops: while the map's owner is asked about a research
 * ticket, a run on it begins only on their word, however it begins. The
 * owner's (or the person asked, if the map has none now) is their decision and
 * clears the ask; anyone else's is refused. With no one asked, a ticket failed
 * twice since its last lift begins only on the map owner's word, or with no
 * owner on the word of a person holding task:decide on it, recorded as the
 * lift (ORCH52-SL14R); a lift with nowhere to be recorded is refused. Asked
 * under the task lock, which the failed handback also takes; a refusal rolls back.
 */
export async function stopRefusal(
  tx: TenantQuery,
  taskId: string,
  starter: Starter,
): Promise<CommandRefusal | undefined> {
  const facts = await wayfinderFacts(tx, taskId);
  if (facts?.type !== 'research') return undefined;
  const asked = await openAsk(tx, taskId);
  if (asked !== undefined) {
    if (starter.personId !== (facts.mapOwner ?? asked)) return refuseStopped();
    await clearAsk(tx, taskId, starter.personId);
  } else if (await failedTwice(tx, taskId)) {
    const lifts =
      facts.mapOwner === null
        ? await mayDecide(tx, taskId, starter)
        : starter.personId === facts.mapOwner;
    if (!lifts) return refuseStopped();
    if (!(await researchLifted(tx, taskId, starter.actorId))) {
      return refuseCommand('TRANSITION_NOT_PERMITTED', ['stopped'], [UNRECORDED_FIX]);
    }
  }
  return undefined;
}

/**
 * WF-7 at pickup: a stopped research ticket's run is not picked up, whoever
 * approved it. A pickup is no one's word, so it never lifts the stop.
 */
export async function pickupStopRefusal(
  tx: TenantQuery,
  taskId: string,
): Promise<CommandRefusal | undefined> {
  if ((await wayfinderFacts(tx, taskId))?.type !== 'research') return undefined;
  return (await isStopped(tx, taskId)) ? refuseStopped() : undefined;
}

/** Asked about the ticket, or failed twice since its last lift. */
async function isStopped(tx: TenantQuery, taskId: string): Promise<boolean> {
  return (await openAsk(tx, taskId)) !== undefined || (await failedTwice(tx, taskId));
}

/**
 * WF-7: `task.restart` of a research ticket's run is a person's start (an
 * agent never restarts): `run:write`, then the stop, then the skill pinned on
 * the restarted run, as `task.propose` asks them. A restart writes no claim.
 * Asked once the restart's proposal holds the task lock; a refusal rolls back.
 */
export async function researchRestartRefusal(
  tx: TenantQuery,
  taskId: string,
  runId: string,
  restarter: Session,
): Promise<CommandRefusal | undefined> {
  if ((await wayfinderFacts(tx, taskId))?.type !== 'research') return undefined;
  const refusal =
    (await researchRunRefusal(tx, taskId, subjectsOf(restarter))) ??
    (await stopRefusal(tx, taskId, restarter));
  if (refusal !== undefined) return refusal;
  const pinned = await pinResearchSkillOnStart(tx, {
    runId,
    starter: { kind: 'person', actorId: restarter.actorId },
  });
  return pinned.ok ? undefined : pinned.refusal;
}

/** `stopRefusal` for the ticket a gate's run is on: an approval begins that run. */
export async function stopRefusalAtGate(
  tx: TenantQuery,
  gateId: string,
  starter: Starter,
): Promise<CommandRefusal | undefined> {
  const rows = await tx.query<{ readonly task: string }>(
    `select r.task_id as task from public.gates g
       join public.planned_runs r on r.business_id = g.business_id and r.id = g.run_id
      where g.business_id = $1 and g.id = $2`,
    [tx.businessId, gateId],
  );
  return rows[0] === undefined ? undefined : await stopRefusal(tx, rows[0].task, starter);
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
  delegation?: Delegation,
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
const STOPPED_FIX =
  "This research failed twice: its map's owner starts it again, or if it has none, " +
  'a person who may decide on the ticket.';
const UNRECORDED_FIX =
  'This business has no comment type to record the lift on the ticket, so the stop holds.';
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

const refuseStopped = (): CommandRefusal =>
  refuseCommand('TRANSITION_NOT_PERMITTED', ['stopped'], [STOPPED_FIX]);

const mayDecide = async (tx: TenantQuery, taskId: string, starter: Starter) =>
  (
    await checkAuthority(
      tx,
      [
        { kind: 'person', id: starter.personId },
        { kind: 'actor', id: starter.actorId },
      ],
      {
      collection: 'task',
      action: 'decide',
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
