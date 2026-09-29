// SPDX-License-Identifier: AGPL-3.0-only
//
// `budget.top_up` (T2e): the envelope asked `decide` on `billing`; here the
// task and amounts are checked, and the runtime applies the four-eyes band.

import { isUuid, subjectsOf, type TenantQuery } from '../../../core-records/src/index.ts';
import { topUp } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';

const whole = (value: number, least: number): boolean =>
  Number.isSafeInteger(value) && value >= least;

export async function topUpOnTask(
  tx: TenantQuery,
  context: CommandContext,
  fields: {
    readonly recordId: unknown;
    readonly amountMinor: number;
    readonly fromMaximumMinor: number;
  },
): Promise<HandlerOutcome> {
  if (typeof fields.recordId !== 'string') {
    return refused(refuseCommand('COMMAND_BODY_INVALID', ['recordId'], ['Name the task.']));
  }
  const invalid = [
    ...(whole(fields.amountMinor, 1) ? [] : ['amountMinor']),
    ...(whole(fields.fromMaximumMinor, 0) ? [] : ['fromMaximumMinor']),
  ];
  const fix = 'Top up by whole minor units above zero, of the maximum the task read showed.';
  if (invalid.length > 0) return refused(refuseCommand('FIELD_VALUE_INVALID', invalid, [fix]));
  if (!isUuid(fields.recordId)) return refused(refuseNotFound());
  const taskId = fields.recordId.toLowerCase();
  const tasks = await tx.query(
    `select id from public.records
      where business_id = $1 and record_type_id = $2 and id = $3 and deleted_at is null`,
    [tx.businessId, context.spine.taskTypeId, taskId],
  );
  if (tasks.length === 0) return refused(refuseNotFound());
  const result = await topUp(tx, {
    taskId,
    amountMinor: BigInt(fields.amountMinor),
    fromMaximumMinor: BigInt(fields.fromMaximumMinor),
    personId: context.session.personId,
    subjects: subjectsOf(context.session),
    collection: context.declaration.collection,
  });
  return result.ok ? applied(taskId, null, { ...result.value }) : refused(result.refusal);
}
