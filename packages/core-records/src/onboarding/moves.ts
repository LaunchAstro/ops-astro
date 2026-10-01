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
 * Each ready person or client-wait step of a running onboarding, on its own
 * client's task, and whoever owns its move: the step task's assignee, else the
 * person who started the onboarding (CS-15.4). The task row is locked, so an
 * assignment being written is waited on and its assignee read.
 */
const MOVES = `select s.task_id, coalesce(r.uuid_2, a.person_id) as owner
     from public.onboarding_steps s
     join public.onboardings o on o.business_id = s.business_id and o.id = s.onboarding_id
     join public.actors a on a.business_id = o.business_id and a.id = o.started_by_actor_id
     join public.records r on r.business_id = s.business_id and r.id = s.task_id
    where s.business_id = $1 and s.kind in ('person', 'client') and s.state = 'ready'
      and o.state = 'running' and r.uuid_7 = o.client_id and`;

async function park(
  tx: TenantQuery,
  steps: string,
  values: readonly unknown[],
): Promise<readonly { readonly task_id: string; readonly owner: string | null }[]> {
  const moves = await tx.query<{ readonly task_id: string; readonly owner: string | null }>(
    `${MOVES} ${steps} order by s.position for update of r`,
    [tx.businessId, ...values],
  );
  for (const move of moves) {
    if (move.owner === null) continue;
    // oxlint-disable-next-line no-await-in-loop -- one item per parked step
    await raiseInboxItem(tx, {
      recipientPersonId: move.owner,
      subjectRecordId: move.task_id,
      reason: 'assignment',
      fact: { kind: 'record', id: move.task_id },
    });
  }
  return moves;
}

/**
 * Park each of these steps, now ready, with an inbox item to whoever owns its
 * move (CS-15.4, `inbox item raised (owns_the_move)`). CS-16.8 has no reason of
 * that name; the move is the task's, so it is raised as the task's
 * `assignment`. An agent step parks at its run's gate.
 */
export async function raiseStepMoves(
  tx: TenantQuery,
  onboardingId: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  await park(tx, 's.onboarding_id = $2 and s.step_key = any($3::text[])', [onboardingId, keys]);
}

/**
 * A step task's assignee or client was written, after `raiseAssignment`: its
 * move is parked again under the owner rule, so an unassigned step falls back
 * to the starter and one taken by its assignee is theirs. An item held by
 * anyone but the assignee and the owner is withdrawn, as when the task has
 * moved to another client and is no longer this onboarding's step.
 */
export async function reparkStepMove(tx: TenantQuery, taskId: string): Promise<void> {
  const [move] = await park(tx, 's.task_id = $2', [taskId]);
  await tx.query(
    `update public.inbox_items i set work_state = 'withdrawn', closed_at = now()
       from public.records r
      where i.business_id = $1 and r.business_id = $1 and r.id = $2
        and i.subject_record_id = $2 and i.reason = 'assignment' and i.fact_kind = 'record'
        and i.fact_id = $2 and i.work_state = 'open'
        and i.recipient_person_id is distinct from r.uuid_2
        and i.recipient_person_id is distinct from $3::uuid
        and exists (select 1 from public.onboarding_steps s
                     where s.business_id = $1 and s.task_id = $2)`,
    [tx.businessId, taskId, move?.owner ?? null],
  );
}

/**
 * The step's move is made: its open item closes, cleared by the person who
 * recorded the result, or withdrawn when an agent did (withdrawn names nobody).
 * The task row is locked first, so an assignment being written, which may
 * park the step again, is waited on and its item closed too.
 */
export async function closeStepMove(
  tx: TenantQuery,
  step: OnboardingStepRow,
  byActorId: string,
): Promise<void> {
  await tx.query('select 1 from public.records where business_id = $1 and id = $2 for update', [
    tx.businessId,
    step.taskId,
  ]);
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
