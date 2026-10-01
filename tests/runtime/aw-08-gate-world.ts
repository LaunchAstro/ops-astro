// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08 (b)'s shared steps over AW-04's world (two businesses, one database):
// work proposed with the synthetic effect, approved either as the launch of a
// reviewed output (`task.decide`) or as a plan (the real accept), picked up by
// the agent and dispatched through the agent's own command entry.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { acceptAs, acceptRequest } from './aw-04-world.ts';
import {
  appliedDetail,
  approveBody,
  asAgent,
  asPerson,
  createTask,
  freshPurpose,
  pickup,
  proposeBody,
  revisionOf,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

export const EFFECT = { kind: 'synthetic_comment', payload: {} } as const;

export interface Leased {
  readonly taskId: string;
  readonly proposal: Detail;
  readonly picked: Detail;
  readonly credential: string;
}

/** A task with the synthetic effect proposed on it; the title carries `canary` when given. */
export async function proposedEffect(
  s: Schedules,
  canary = 'aw08',
): Promise<Detail & { taskId: string }> {
  const taskId = await createTask(s, `${canary}-${randomUUID()}`);
  const body = {
    ...proposeBody(taskId, await revisionOf(s, taskId), { purpose: freshPurpose() }),
    step: EFFECT,
  };
  return { ...appliedDetail(await asPerson(s, body), 'task.propose'), taskId };
}

/** Proposed, approved as `how` and picked up by the agent. */
export async function leased(
  s: Schedules,
  how: 'launch' | 'plan',
  canary?: string,
): Promise<Leased> {
  const proposal = await proposedEffect(s, canary);
  let reservationId: unknown;
  if (how === 'launch') {
    reservationId = appliedDetail(await asPerson(s, approveBody(proposal)), 'task.decide')[
      'reservationId'
    ];
  } else {
    const accepted = await acceptAs(s, acceptRequest(s, { taskId: proposal.taskId, proposal }));
    if (!accepted.ok) throw new Error(`accept refused ${accepted.refusal.code}`);
    reservationId = accepted.value.reservationId;
  }
  const picked = await pickup(s, reservationId);
  return { taskId: proposal.taskId, proposal, picked, credential: String(picked['credential']) };
}

/** `task.dispatch` on the work's lease, as the agent under the given credential. */
export async function dispatchAs(
  s: Schedules,
  work: Leased,
  credential: string = work.credential,
): Promise<CommandResult> {
  return await asAgent(
    s,
    {
      command: 'task.dispatch',
      operationId: randomUUID(),
      leaseId: work.picked['leaseId'],
      fence: work.picked['fence'],
    },
    credential,
  );
}

/** Steps of the task's runs a dispatch has marked. */
export async function marked(s: Schedules, taskId: string): Promise<number> {
  const found = await rows<{ n: string }>(
    s,
    `select count(*)::text as n from public.planned_steps st
       join public.planned_runs run on run.business_id = st.business_id and run.id = st.run_id
      where run.business_id = $1 and run.task_id = $2 and st.dispatch_marked`,
    [s.business, taskId],
  );
  return Number(found[0]?.n);
}

/** The business's `client_sign_off_required`, set as its owner connection would. */
export async function setSignOff(s: Schedules, on: boolean): Promise<void> {
  await s.db.app.withBusiness(s.business, async (tx) => {
    await installBusinessSettings(tx);
  });
  await s.db.admin.execute(
    `update public.business_settings set value = $2::jsonb
      where business_id = $1 and key = 'client_sign_off_required'`,
    [s.business, JSON.stringify(on)],
  );
  const read = await rows<{ v: unknown }>(
    s,
    `select value as v from public.business_settings
      where business_id = $1 and key = 'client_sign_off_required'`,
    [s.business],
  );
  expect(read[0]?.v).toBe(on);
}
