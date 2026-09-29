// SPDX-License-Identifier: AGPL-3.0-only
//
// `budget.record_outcome` (T3d1): the envelope asked `decide` on `billing`;
// here the task, the attempt on it and the outcome are checked, and the
// runtime records it under the step's locks. A retry replays by operation
// identity through the register, before this runs.

import { isUuid, subjectsOf, type TenantQuery } from '../../../core-records/src/index.ts';
import {
  RECORDED_OUTCOMES,
  recordOutcome,
  type RecordedOutcome,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const isOutcome = (value: unknown): value is RecordedOutcome =>
  typeof value === 'string' && (RECORDED_OUTCOMES as readonly string[]).includes(value);

export async function recordOutcomeOnTask(
  tx: TenantQuery,
  context: CommandContext,
  fields: { readonly recordId: unknown; readonly attemptId: unknown; readonly outcome: unknown },
): Promise<HandlerOutcome> {
  const missing = (['recordId', 'attemptId'] as const).filter(
    (name) => typeof fields[name] !== 'string',
  );
  if (missing.length > 0) {
    return refused(
      refuseCommand('COMMAND_BODY_INVALID', missing, ['Name the task and its attempt.']),
    );
  }
  if (!isOutcome(fields.outcome)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['outcome'],
        [`Record one of ${RECORDED_OUTCOMES.join(', ')}. An effect not yet known keeps its stop.`],
      ),
    );
  }
  const { recordId, attemptId } = fields as {
    readonly recordId: string;
    readonly attemptId: string;
  };
  if (!isUuid(recordId) || !isUuid(attemptId)) return refused(refuseNotFound());
  const taskId = recordId.toLowerCase();
  // The attempt answers only through a run on this task, in this business.
  const found = await tx.query(
    `select 1 from public.attempts att
       join public.planned_runs run on run.business_id = att.business_id and run.id = att.run_id
       join public.records task on task.business_id = run.business_id and task.id = run.task_id
      where att.business_id = $1 and att.id = $2 and run.task_id = $3
        and task.record_type_id = $4 and task.deleted_at is null`,
    [tx.businessId, attemptId.toLowerCase(), taskId, context.spine.taskTypeId],
  );
  if (found.length === 0) return refused(refuseNotFound());
  const result = await recordOutcome(tx, {
    taskId,
    attemptId: attemptId.toLowerCase(),
    outcome: fields.outcome,
    subjects: subjectsOf(context.session),
    collection: context.declaration.collection,
  });
  return result.ok ? applied(taskId, null, { ...result.value }) : refused(result.refusal);
}
