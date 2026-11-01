// SPDX-License-Identifier: AGPL-3.0-only
//
// A request to delete a task (#2351), and a person's answer to it.
//
// An agent never deletes. `task.request_delete` records what it asks, with its
// reason, on the task: one open request at a time, lapsing seven days after it
// is made. `task.confirm_delete` and `task.decline_delete` are `task:decide`
// and never in an agent's reach (`surface.ts`), so no agent credential can
// answer one, its own included. Confirm is `task.delete`'s bin with its
// refusals, run as the person; a refusal there rolls the answer back with it,
// and the request stays open for Keep.
//
// Every write here runs under the task's row lock, which the envelope takes
// before the handler, so a request and its answers on one task wait for one
// another. Whether a request is still open is asked of the clock inside the
// statement that answers it, after that wait.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { invalid } from './operands.ts';
import { applied, isRefused, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';
import { deleteTask } from './tasks-delete.ts';

/** A reason's longest, as the other reasons a task records (`tasks-controls.ts`). */
const REASON_LIMIT = 500;
/** How long a request waits for a person before it lapses. */
const OPEN_FOR = '7 days';

const PENDING_FIXES: readonly string[] = [
  'This task already has a request to delete it, waiting for a person.',
  'Wait for them to confirm it or keep the task.',
];
const NOT_PENDING_FIXES: readonly string[] = [
  'This task has no open request to delete it: it was answered, or it lapsed after seven days.',
  'Read the task again. To delete it yourself, use Delete task.',
];

/**
 * An agent's (or a person's) request to delete the target. Lapsed requests are
 * closed first, so the one-open index admits a new one once the old has lapsed.
 */
export async function requestDelete(
  tx: TenantQuery,
  context: CommandContext,
  reason: unknown,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('requestDelete: the envelope read no target');
  if (typeof reason !== 'string' || reason.trim() === '' || reason.length > REASON_LIMIT) {
    return refused(invalid('reason', `Say why, in 1 to ${REASON_LIMIT} characters.`));
  }
  await tx.query(
    `update public.task_delete_requests
        set answer = 'lapsed', answered_at = expires_at
      where business_id = $1 and task_id = $2 and answer is null
        and expires_at <= clock_timestamp()`,
    [tx.businessId, target.id],
  );
  const made = await tx.query<{ readonly id: string; readonly expires_at: string }>(
    `insert into public.task_delete_requests
       (business_id, id, task_id, reason, requested_by_actor_id, requested_for_person_id,
        requested_at, expires_at)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, clock_timestamp(),
             clock_timestamp() + $6::interval)
     on conflict (business_id, task_id) where answer is null do nothing
     returning id, expires_at::text as expires_at`,
    [
      tx.businessId,
      target.id,
      reason.trim(),
      context.session.actorId,
      context.session.personId,
      OPEN_FOR,
    ],
  );
  const request = made[0];
  if (request === undefined) {
    return refused(refuseCommand('DELETE_REQUEST_PENDING', ['recordId'], PENDING_FIXES));
  }
  return applied(target.id, target.revision, {
    requestId: request.id,
    expiresAt: request.expires_at,
  });
}

/**
 * A person's answer to the target's open request: `confirmed` deletes the task
 * as `task.delete` does, `kept` closes the request and leaves the task.
 */
export async function answerDeleteRequest(
  tx: TenantQuery,
  context: CommandContext,
  answer: 'confirmed' | 'kept',
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('answerDeleteRequest: the envelope read no target');
  const answered = await tx.query<{ readonly id: string }>(
    `update public.task_delete_requests
        set answer = $3, answered_by_actor_id = $4, answered_at = clock_timestamp()
      where business_id = $1 and task_id = $2 and answer is null
        and expires_at > clock_timestamp()
      returning id`,
    [tx.businessId, target.id, answer, context.session.actorId],
  );
  const request = answered[0];
  if (request === undefined) {
    return refused(refuseCommand('DELETE_REQUEST_NOT_PENDING', ['recordId'], NOT_PENDING_FIXES));
  }
  if (answer === 'kept') {
    return applied(target.id, target.revision, { requestId: request.id, answer });
  }
  const deleted = await deleteTask(tx, context);
  if (isRefused(deleted)) return deleted;
  return { ...deleted, detail: { ...deleted.detail, requestId: request.id, answer } };
}
