// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08's path from a plan to an effect, through the production command entry:
// the plan is proposed and accepted, the agent picks it up and hands its
// output back with a successor (the reviewed output), and a person's accept of
// that successor is the launch. Only the launched lease may dispatch.

import { randomUUID } from 'node:crypto';
import {
  appliedDetail,
  approve,
  asAgent,
  asPerson,
  createTask,
  freshPurpose,
  handbackBody,
  pickup,
  proposeBody,
  revisionOf,
  rows,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

/** The one catalogued effect, replayable by its token. */
export const EFFECT = { kind: 'synthetic_comment', payload: {} } as const;

/** A plan with the effect as its step, proposed by the decider on a task of its own. */
export async function proposeEffect(
  s: Schedules,
  title: string,
  maximumMinor = 2_000,
): Promise<{ readonly taskId: string; readonly plan: Detail }> {
  const taskId = await createTask(s, `${title}-${randomUUID()}`);
  const body = proposeBody(taskId, await revisionOf(s, taskId), {
    maximumMinor,
    purpose: freshPurpose(),
  });
  const plan = appliedDetail(await asPerson(s, { ...body, step: EFFECT }), 'task.propose');
  return { taskId, plan };
}

/** The successor a handback asks for: the reviewed output, carrying the effect. */
export function reviewedOutput(maximumMinor = 2_000): Body {
  return {
    purpose: freshPurpose(),
    maximumMinor,
    currency: 'AUD',
    payload: { change: 'the reviewed output' },
    step: EFFECT,
  };
}

/** The work handed back for review: the successor's version and pending gate. */
export async function handBack(
  s: Schedules,
  working: Detail,
  maximumMinor = 2_000,
): Promise<Detail> {
  const handed = await asAgent(
    s,
    handbackBody(working, reviewedOutput(maximumMinor)),
    String(working['credential']),
  );
  return appliedDetail(handed, 'task.handback');
}

export interface Launched {
  readonly taskId: string;
  readonly plan: Detail;
  /** The plan's lease: the agent works under it and fires nothing. */
  readonly working: Detail;
  readonly handedBack: Detail;
  /** The launched lease, the one that may dispatch. */
  readonly picked: Detail;
}

/** A person's approval of a proposal's gate: the decider's unless a test names another. */
export type Approver = (proposal: Detail) => Promise<Detail>;

/** Proposed, plan accepted, handed back, launched and picked up, each accept by `decide`. */
export async function launched(
  s: Schedules,
  title: string,
  decide: Approver = async (proposal) => await approve(s, proposal),
): Promise<Launched> {
  const { taskId, plan } = await proposeEffect(s, title);
  const working = await pickup(s, (await decide(plan))['reservationId']);
  const handedBack = await handBack(s, working);
  const launch = await decide({
    gateId: handedBack['successorGateId'],
    versionId: handedBack['successorVersionId'],
  });
  const picked = await pickup(s, launch['reservationId']);
  return { taskId, plan, working, handedBack, picked };
}

export function dispatchBody(picked: Detail): Body {
  return {
    command: 'task.dispatch',
    operationId: randomUUID(),
    leaseId: picked['leaseId'],
    fence: picked['fence'],
  };
}

/** Steps of `taskId`'s runs that a dispatch has marked. */
export async function marked(s: Schedules, taskId: string): Promise<number> {
  const found = await rows<{ n: string }>(
    s,
    `select count(*)::text as n
       from public.planned_steps st
       join public.planned_runs r on r.business_id = st.business_id and r.id = st.run_id
      where r.business_id = $1 and r.task_id = $2 and st.dispatch_marked`,
    [s.business, taskId],
  );
  return Number(found[0]?.n);
}

/** The reviewed-output marks on `taskId`'s lineages, as the owner sees them. */
export async function marksOf(s: Schedules, taskId: string): Promise<readonly string[]> {
  const found = await rows<{ version_id: string }>(
    s,
    `select ro.version_id
       from public.reviewed_outputs ro
       join public.proposal_lineages l on l.business_id = ro.business_id and l.id = ro.lineage_id
      where l.business_id = $1 and l.task_id = $2 order by ro.marked_at`,
    [s.business, taskId],
  );
  return found.map((row) => row.version_id);
}
