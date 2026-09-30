// SPDX-License-Identifier: AGPL-3.0-only
//
// An onboarding's moves (C41-A, CS-15.4): a person or client-wait step that
// opens is parked with an inbox item to whoever owns its move, and the item
// closes when the step's result is recorded. Beside `onboardings.ts`, whose
// step rows it reads; the inbox's own rules (`../inbox/items.ts`) hold the item.

import type { TenantQuery } from '../tenancy/database.ts';
import { raiseInboxItem } from '../inbox/items.ts';
import type { OnboardingStepRow } from './onboardings.ts';

/**
 * Park each of these steps that a person or the client moves, now ready, with
 * an inbox item to whoever owns the move: the step task's assignee, else the
 * person who started the onboarding (CS-15.4, `inbox item raised
 * (owns_the_move)`). CS-16.8 has no reason of that name; the move is the
 * task's, so it is raised as the task's `assignment`, and reassigning the task
 * moves it as any assignment does. An agent step parks at its run's gate.
 */
export async function raiseStepMoves(
  tx: TenantQuery,
  onboardingId: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  const moves = await tx.query<{ readonly task_id: string; readonly owner: string | null }>(
    `select s.task_id, coalesce(r.uuid_2, a.person_id) as owner
       from public.onboarding_steps s
       join public.onboardings o on o.business_id = s.business_id and o.id = s.onboarding_id
       join public.actors a on a.business_id = o.business_id and a.id = o.started_by_actor_id
       join public.records r on r.business_id = s.business_id and r.id = s.task_id
      where s.business_id = $1 and s.onboarding_id = $2 and s.step_key = any($3::text[])
        and s.kind in ('person', 'client') and s.state = 'ready'
      order by s.position`,
    [tx.businessId, onboardingId, keys],
  );
  for (const move of moves) {
    if (move.owner === null) continue;
    // oxlint-disable-next-line no-await-in-loop -- one item per opened step
    await raiseInboxItem(tx, {
      recipientPersonId: move.owner,
      subjectRecordId: move.task_id,
      reason: 'assignment',
      fact: { kind: 'record', id: move.task_id },
    });
  }
}

/**
 * The step's move is made: its open item closes, cleared by the person who
 * recorded the result, or withdrawn when an agent did (withdrawn names nobody).
 */
export async function closeStepMove(
  tx: TenantQuery,
  step: OnboardingStepRow,
  byActorId: string,
): Promise<void> {
  await tx.query(
    `update public.inbox_items i
        set work_state = case when a.person_id is null then 'withdrawn' else 'cleared' end,
            closed_at = now(), closed_by_person_id = a.person_id
       from public.actors a
      where i.business_id = $1 and a.business_id = $1 and a.id = $3
        and i.subject_record_id = $2 and i.reason = 'assignment'
        and i.fact_kind = 'record' and i.fact_id = $2 and i.work_state = 'open'`,
    [tx.businessId, step.taskId, byActorId],
  );
}
