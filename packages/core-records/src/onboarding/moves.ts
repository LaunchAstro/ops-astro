// SPDX-License-Identifier: AGPL-3.0-only
//
// An onboarding's moves (C41-A, CS-15.4): a person or client-wait step that
// opens is parked with an inbox item to whoever owns its move, and the item
// closes when the step's result is recorded, or is withdrawn when the
// onboarding stops.

import type { TenantQuery } from '../tenancy/database.ts';
import { raiseInboxItem } from '../inbox/items.ts';

/**
 * Each ready person or client-wait step of a running onboarding, on its own
 * client's task out of the trash, and whoever owns its move: the step task's assignee, else the
 * person who started the onboarding (CS-15.4). The task row is locked, so an
 * assignment being written is waited on and its assignee read.
 */
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
  // Lock first, read after. Each named step's task row is locked whatever this
  // statement's snapshot says of its trash and client, so a restore or a
  // client move in flight on it is waited on; the moves are then read in a
  // statement of their own, which sees what that committed.
  await tx.query(
    `select r.id from public.onboarding_steps s
       join public.records r on r.business_id = s.business_id and r.id = s.task_id
      where s.business_id = $1 and ${steps} order by s.position for update of r`,
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

/**
 * Park these steps, now ready (CS-15.4, `inbox item raised (owns_the_move)`).
 * CS-16.8 has no reason of that name; the move is the task's, so it is raised
 * as the task's `assignment`. An agent step parks at its run's gate.
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
 * Tasks back from the trash: a step among them that opened while its task was
 * in the trash was parked with nobody (`MOVES` reads live tasks only), so each
 * ready one is parked now. The restore holds each task's row; a result opening
 * one of these steps meanwhile waits on it in `park` and parks it once the
 * restore commits, and one that committed first is read as ready here.
 */
export async function parkRestoredSteps(
  tx: TenantQuery,
  taskIds: readonly string[],
): Promise<void> {
  if (taskIds.length === 0) return;
  await park(tx, 's.task_id = any($2::uuid[])', [taskIds]);
}

/**
 * The onboarding stopped (its second failure): no step of it takes a result
 * until a person restarts it, so the open move on each step that was owed one
 * (ready, or the one that stopped) is withdrawn (withdrawn names nobody). An
 * ordinary assignment on a blocked or closed step's task is no step's move and
 * stays. The caller holds the onboarding's lock.
 */
export async function withdrawStepMoves(tx: TenantQuery, onboardingId: string): Promise<void> {
  await tx.query(
    `update public.inbox_items i set work_state = 'withdrawn', closed_at = now()
       from public.onboarding_steps s
      where i.business_id = $1 and s.business_id = $1 and s.onboarding_id = $2
        and i.subject_record_id = s.task_id and i.reason = 'assignment'
        and i.fact_kind = 'record' and i.fact_id = s.task_id and i.work_state = 'open'
        and s.state in ('ready', 'stopped')`,
    [tx.businessId, onboardingId],
  );
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
 * The caller holds the task row's lock (`lockStepOfTask`), so an assignment
 * being written, which may park the step again, was waited on and its item is
 * closed too.
 */
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
