// SPDX-License-Identifier: AGPL-3.0-only
//
// The T3d1 suite's harness (`t3d1-reconcile.test.ts`): an unknown step made
// the way T3b makes one (dispatch, the lease runs out, the sweep), the pass's
// reconciliation phase run as the API runs it, the effect counter and the
// money a pass or a recorded outcome may move. Kept apart so the suite stays
// under the per-file cap.

import { randomUUID } from 'node:crypto';
import { reconcileUnknown, type EffectLookup } from '../../packages/core-runtime/src/index.ts';
import { registerEffectLookup } from '../../apps/api/recovery-entry.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import { appliedDetail, asAgent, asPerson, rows, type Schedules } from './schedules-harness.ts';
import { MAXIMUM, t2dHarness, type Work } from './t2d-harness.ts';
import { t3bHarness } from './t3b-harness.ts';

/** The lookup that cannot answer: the register is never asked (the fixture route). */
export const CANNOT_ANSWER: EffectLookup = async () => await Promise.resolve(undefined);

export interface T3d1Harness {
  readonly t2d: ReturnType<typeof t2dHarness>;
  readonly t3b: ReturnType<typeof t3bHarness>;
  /** Approved work, dispatched, applied or not, its lease run out and swept: held unknown. */
  readonly unknownStep: (options: {
    readonly applied: boolean;
    readonly room?: boolean;
  }) => Promise<Work>;
  /** The envelope raised by one more hold, by the person who approved it (T2e). */
  readonly room: (w: Work) => Promise<void>;
  readonly reconcile: (lookup?: EffectLookup) => ReturnType<typeof reconcileUnknown>;
  /** Applied effects on the task's attempts: the effect counter. */
  readonly effects: (w: Work) => Promise<number>;
  /** Every hold on the work's version, oldest first. */
  readonly holds: (w: Work) => Promise<readonly Record<string, unknown>[]>;
  readonly envelope: (w: Work) => Promise<Record<string, unknown> | undefined>;
  /** The replacement hold a resumed step reserved, if any. */
  readonly replacement: (w: Work) => Promise<string | undefined>;
  readonly outcome: (w: Work, outcome: string, operationId?: string) => ReturnType<typeof asPerson>;
  /** The old identity presented again by a worker that was paused, then woken. */
  readonly wokenApply: (w: Work) => ReturnType<typeof asAgent>;
}

export function t3d1Harness(get: () => Schedules): T3d1Harness {
  const t2d = t2dHarness(get);
  const t3b = t3bHarness(get);

  const room = async (w: Work): Promise<void> => {
    appliedDetail(
      await asPerson(get(), {
        command: 'budget.top_up',
        operationId: randomUUID(),
        recordId: w.taskId,
        amountMinor: MAXIMUM,
        fromMaximumMinor: MAXIMUM,
      }),
      'budget.top_up',
    );
  };

  const unknownStep = async (options: { readonly applied: boolean; readonly room?: boolean }) => {
    const w = await t2d.work();
    if (options.room === true) await room(w);
    if (options.applied) await t2d.applied(w);
    else await t2d.dispatched(w);
    await t3b.expire(w);
    await t3b.sweep();
    return w;
  };

  const reconcile = async (lookup: EffectLookup = registerEffectLookup) =>
    await get().db.app.withBusiness(
      get().business,
      async (tx) => await reconcileUnknown(tx, lookup),
    );

  const effects = async (w: Work): Promise<number> =>
    (
      await rows(
        get(),
        `select 1 from public.operations
          where business_id = $1 and record_id = $2 and command = 'task.comment'
            and outcome = 'applied' and operation_id like 'effect:%'`,
        [get().business, w.taskId],
      )
    ).length;

  const holds = async (w: Work) =>
    await rows<Record<string, unknown>>(
      get(),
      `select res.id, res.state, res.held_minor::text as held, res.actual_minor::text as actual,
              (res.absence_proved_at is not null) as absence_proved, att.id as attempt_id,
              att.state as attempt_state
         from public.reservations res
         join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
        where res.business_id = $1 and res.version_id = $2
        order by res.created_at, res.id`,
      [get().business, w.decision['versionId'] ?? w.proposal['versionId']],
    );

  const envelope = async (w: Work) =>
    (
      await rows<Record<string, unknown>>(
        get(),
        `select held_minor::text as held, actual_minor::text as actual,
                maximum_minor::text as maximum
           from public.task_envelopes where business_id = $1 and task_id = $2`,
        [get().business, w.taskId],
      )
    )[0];

  const replacement = async (w: Work) => {
    const found = (await holds(w)).find(
      (hold) => hold['attempt_id'] !== w.attemptId && hold['attempt_state'] === 'reserved',
    );
    return found === undefined ? undefined : String(found['id']);
  };

  const outcome = async (w: Work, value: string, operationId: string = randomUUID()) =>
    await asPerson(get(), {
      command: 'budget.record_outcome',
      operationId,
      recordId: w.taskId,
      attemptId: w.attemptId,
      outcome: value,
    });

  const wokenApply = async (w: Work) =>
    await asAgent(
      get(),
      {
        command: 'task.comment',
        operationId: effectOperationId(w.attemptId),
        recordId: w.taskId,
        // The same request the worker first sent: a retry, not a new comment.
        body: 'The synthetic change, applied once. Nothing left the app.',
        audience: 'internal',
      },
      w.credential,
    );

  return {
    t2d,
    t3b,
    unknownStep,
    room,
    reconcile,
    effects,
    holds,
    envelope,
    replacement,
    outcome,
    wokenApply,
  };
}
