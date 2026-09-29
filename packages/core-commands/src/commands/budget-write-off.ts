// SPDX-License-Identifier: AGPL-3.0-only
//
// `budget.write_off` (T3c): the envelope asked `decide` on `billing`; here the
// task, the attempt on it, the amount and the written reason are checked, and
// the runtime closes the unknown hold under the step's locks, pairing a second
// person above the four-eyes band. A retry replays by operation identity
// through the register, before this runs. No agent route reaches it.

import { isUuid, subjectsOf, type TenantQuery } from '../../../core-records/src/index.ts';
import { writeOff } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

/** A written reason a person reads later: said, and not a document. */
const REASON_MAX = 2_000;

export async function writeOffOnTask(
  tx: TenantQuery,
  context: CommandContext,
  fields: {
    readonly recordId: unknown;
    readonly attemptId: unknown;
    readonly amountMinor: unknown;
    readonly reason: unknown;
  },
): Promise<HandlerOutcome> {
  const { recordId, attemptId, amountMinor, reason } = fields;
  if (typeof recordId !== 'string' || typeof attemptId !== 'string') {
    const missing = typeof recordId === 'string' ? ['attemptId'] : ['recordId'];
    return refused(
      refuseCommand('COMMAND_BODY_INVALID', missing, ['Name the task and its attempt.']),
    );
  }
  // The wire refused a missing or non-number amount and a non-string reason.
  const invalid = [
    ...(Number.isSafeInteger(amountMinor) && (amountMinor as number) >= 0 ? [] : ['amountMinor']),
    ...(typeof reason === 'string' && reason.trim() !== '' && reason.length <= REASON_MAX
      ? []
      : ['reason']),
  ];
  if (invalid.length > 0) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', invalid, [
        `Charge whole minor units from 0 to the hold, and say why in up to ${String(REASON_MAX)} characters.`,
      ]),
    );
  }
  if (!isUuid(recordId) || !isUuid(attemptId)) return refused(refuseNotFound());
  const taskId = recordId.toLowerCase();
  const attempt = attemptId.toLowerCase();
  // The attempt answers only through a run on this task, in this business.
  const found = await tx.query(
    `select 1 from public.attempts att
       join public.planned_runs run on run.business_id = att.business_id and run.id = att.run_id
       join public.records task on task.business_id = run.business_id and task.id = run.task_id
      where att.business_id = $1 and att.id = $2 and run.task_id = $3
        and task.record_type_id = $4 and task.deleted_at is null`,
    [tx.businessId, attempt, taskId, context.spine.taskTypeId],
  );
  if (found.length === 0) return refused(refuseNotFound());
  const result = await writeOff(tx, {
    taskId,
    attemptId: attempt,
    amountMinor: BigInt(amountMinor as number),
    reason: (reason as string).trim(),
    personId: context.session.personId,
    subjects: subjectsOf(context.session),
    collection: context.declaration.collection,
  });
  return result.ok ? applied(taskId, null, { ...result.value }) : refused(result.refusal);
}
