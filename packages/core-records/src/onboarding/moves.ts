// SPDX-License-Identifier: AGPL-3.0-only
//
// An onboarding's moves (C41-A, CS-15.4): a person or client-wait step parks with an inbox item to its owner.

import type { TenantQuery } from '../tenancy/database.ts';
import { raiseInboxItem } from '../inbox/items.ts';

/** Each ready person or client-wait step on its live, own-client task, and its owner: assignee, else the starter. */
const MOVES = `select s.task_id, coalesce(r.uuid_2, a.person_id) as owner
     from public.onboarding_steps s
     join public.onboardings o on o.business_id = s.business_id and o.id = s.onboarding_id
     join public.actors a on a.business_id = o.business_id and a.id = o.started_by_actor_id
     join public.records r on r.business_id = s.business_id and r.id = s.task_id
    where s.business_id = $1 and s.kind in ('person', 'client') and s.state = 'ready'
      and o.state = 'running' and r.uuid_7 = o.client_id and r.deleted_at is null and`;

async function park(
  tx: TenantQuery,
  steps: string,
  values: readonly unknown[],
): Promise<readonly { readonly task_id: string; readonly owner: string | null }[]> {
  // Lock first, read after: a restore or client move in flight is waited on, then read in a new statement.
  await tx.query(
    `select r.id from public.onboarding_steps s
       join public.records r on r.business_id = s.business_id and r.id = s.task_id
      where s.business_id = $1 and ${steps} order by r.id for update of r`,
    [tx.businessId, ...values],
  );
  const moves = await tx.query<{ readonly task_id: string; readonly owner: string | null }>(
    `${MOVES} ${steps} order by s.position`,
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

/** Park these steps, now ready, as the task's `assignment` item (CS-15.4); an agent step parks at its run's gate. */
export async function raiseStepMoves(
  tx: TenantQuery,
  onboardingId: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  await park(tx, 's.onboarding_id = $2 and s.step_key = any($3::text[])', [onboardingId, keys]);
}

/** Tasks back from the trash: each ready step among them, parked with nobody while trashed, is parked now. */
export async function parkRestoredSteps(
  tx: TenantQuery,
  taskIds: readonly string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  await park(tx, 's.task_id = any($2::uuid[])', [taskIds]);
}

/** The onboarding stopped: withdraw the open move of each ready or stopped step on its own client, task rows locked first. */
export async function withdrawStepMoves(tx: TenantQuery, onboardingId: string): Promise<void> {
  const owed = `from public.onboarding_steps s
       join public.onboardings o on o.business_id = s.business_id and o.id = s.onboarding_id
       join public.records r on r.business_id = s.business_id and r.id = s.task_id
      where s.business_id = $1 and s.onboarding_id = $2 and s.state in ('ready', 'stopped')`;
  await tx.query(`select r.id ${owed} order by r.id for update of r`, [
    tx.businessId,
    onboardingId,
  ]);
  await tx.query(
    `update public.inbox_items i set work_state = 'withdrawn', closed_at = now()
      where i.business_id = $1 and i.reason = 'assignment' and i.fact_kind = 'record'
        and i.work_state = 'open' and i.fact_id = i.subject_record_id
        and i.subject_record_id in (select s.task_id ${owed} and r.uuid_7 = o.client_id)`,
    [tx.businessId, onboardingId],
  );
}

/** A step task's assignee or client changed: park its move again and withdraw items held by anyone else. */
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

/** The step's move is made: its item is cleared by the person, or withdrawn for an agent; the caller holds the task lock. */
export async function closeStepMove(
  tx: TenantQuery,
  step: { readonly taskId: string },
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
