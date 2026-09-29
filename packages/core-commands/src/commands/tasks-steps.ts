// SPDX-License-Identifier: AGPL-3.0-only
//
// What the one completion transition does to a task's steps (MP-4-15, CS-4.2).
//
// Completing a task marks each unfinished live subtask archived, never done:
// `archived_at` and `archived_why` are written and its state is left as it
// was. Reopening removes the mark from exactly the steps this completion
// archived, so each comes back in the state it was in. Both happen in the
// transition's own transaction, beside the state write, so no reader sees a
// completed task with live unfinished steps or a reopened one with archived
// steps.
//
// **Each step is asked about.** A subtask carries grants of its own and the
// parent's grant does not reach it, so the steps are locked and the caller is
// asked `write` on each at its own record scope (a business-wide writer once),
// before anything is written. The first step out of reach refuses the whole
// transition, as `task.move` refuses a subtree it cannot carry.

import { checkAuthority, subjectsOf } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandRefusal } from './refusal.ts';
import type { CommandContext } from './context.ts';

/** Why a step was archived by its parent's completion, the one archiving act today. */
export const PARENT_COMPLETED = 'The parent task was completed.';

export type StepMove = 'archive' | 'restore';

const WHICH: Readonly<Record<StepMove, string>> = {
  // Unfinished: not completed or cancelled, and not already archived.
  archive: `not (r.data ? 'archived_at')
        and coalesce(s.data ->> 'machine_category', '') not in ('completed', 'cancelled')`,
  // Archived by a completion: the mark this transition's opposite wrote.
  restore: `r.data ->> 'archived_why' = '${PARENT_COMPLETED}'`,
};

/**
 * The steps a completion archives or a reopen restores, locked, or the
 * refusal for the first the caller may not write.
 */
export async function lockSteps(
  tx: TenantQuery,
  context: CommandContext,
  parentId: string,
  move: StepMove,
): Promise<
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly refusal: CommandRefusal }
> {
  const found = await tx.query<{ readonly id: string }>(
    `select r.id from public.records r
       left join public.records s
         on s.business_id = r.business_id and s.id = r.uuid_1 and s.deleted_at is null
      where r.business_id = $1 and r.record_type_id = $2 and r.uuid_4 = $3
        and r.deleted_at is null and ${WHICH[move]}
      order by r.id
      for update of r`,
    [tx.businessId, context.spine.taskTypeId, parentId],
  );
  const ids = found.map((row) => row.id);
  if (ids.length === 0) return { ok: true, ids };
  const subjects = subjectsOf(context.session);
  const whole = await checkAuthority(tx, subjects, {
    collection: 'task',
    action: 'write',
    scope: { kind: 'business', id: null },
  });
  if (whole.ok) return { ok: true, ids };
  for (const id of ids) {
    // Sequential, stopping at the first: the answer is the same whichever.
    // eslint-disable-next-line no-await-in-loop
    const reached = await checkAuthority(tx, subjects, {
      collection: 'task',
      action: 'write',
      scope: { kind: 'record', id },
    });
    if (!reached.ok) return { ok: false, refusal: reached.refusal };
  }
  return { ok: true, ids };
}

/** Write the move on the steps `lockSteps` returned, in the same transaction. */
export async function moveSteps(
  tx: TenantQuery,
  ids: readonly string[],
  move: StepMove,
): Promise<void> {
  if (ids.length === 0) return;
  await tx.query(
    move === 'archive'
      ? `update public.records
            set data = data || jsonb_build_object('archived_at', to_jsonb(now()),
                                                  'archived_why', $3::text)
          where business_id = $1 and id = any($2::uuid[])`
      : `update public.records set data = data - 'archived_at' - 'archived_why'
          where business_id = $1 and id = any($2::uuid[]) and $3::text is not null`,
    [tx.businessId, ids, PARENT_COMPLETED],
  );
}
