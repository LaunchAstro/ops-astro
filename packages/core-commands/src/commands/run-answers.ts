// SPDX-License-Identifier: AGPL-3.0-only
//
// `run.top_up` and `run.end_at_budget_stop`: a person's answers to a run
// waiting at its approved ceiling (AW-05), as commands over the runtime
// functions that own them (`core-runtime/src/budget-answer.ts`).
//
// Both name the task and the run on it, like the work controls. The envelope
// has already asked the declaration's `decide` (on `billing` for a top-up, on
// `gate` for the end) of the named task; here the task is found in this
// business and the run is checked against it, so authority on one task never
// reaches a run on another. A run on another task answers with the bytes a
// fabricated run does. The runtime then reads the grant, the threshold, the
// cap and the currency again under the run's locks, and every write is in the
// envelope's one transaction. Neither answer writes the task record: the end
// parks it for a person.

import { isUuid, subjectsOf } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import {
  endAtBudgetStop,
  topUpAtBudgetStop,
  type BudgetAnswerRequest,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';

/**
 * The run on the named task, as the runtime's request, or the refusal.
 *
 * `trashed` says whether a task in the trash still answers. The end reaches
 * one, as cancel does: it only ends the run and releases what it holds, and a
 * hold left counted against the cap with no control to release it is the
 * worse answer. A top-up does not: it opens more work on a task that is gone
 * from the work surface until its batch is restored.
 */
async function runOnTask(
  tx: TenantQuery,
  context: CommandContext,
  recordId: unknown,
  runId: unknown,
  trashed: 'reachable' | 'gone',
): Promise<{ readonly taskId: string; readonly request: BudgetAnswerRequest } | HandlerOutcome> {
  // Absent is the body's shape, and is said so; present and malformed is an
  // identifier that names nothing, and answers as one.
  const absent = [
    ...(typeof recordId === 'string' ? [] : ['recordId']),
    ...(typeof runId === 'string' ? [] : ['runId']),
  ];
  if (absent.length > 0) {
    return refused(
      refuseCommand('COMMAND_BODY_INVALID', absent, ['Name the task and the run on it.']),
    );
  }
  if (!isUuid(recordId)) return refused(refuseNotFound());
  const taskId = recordId.toLowerCase();
  const tasks = await tx.query<{ readonly id: string }>(
    `select id from public.records
      where business_id = $1 and record_type_id = $2 and id = $3
        and ($4 or deleted_at is null)`,
    [tx.businessId, context.spine.taskTypeId, taskId, trashed === 'reachable'],
  );
  if (tasks[0] === undefined) return refused(refuseNotFound());
  if (!isUuid(runId)) return refused(refuseNotFound(['runId']));
  const runs = await tx.query<{ readonly task_id: string }>(
    `select task_id from public.planned_runs where business_id = $1 and id = $2`,
    [tx.businessId, runId],
  );
  // No run, and a run on another task, are one answer: the caller's authority
  // is on the task they named, and it says nothing about any other.
  if (runs[0]?.task_id !== taskId) return refused(refuseNotFound(['runId']));
  return {
    taskId,
    request: {
      runId: runId.toLowerCase(),
      caller: {
        kind: 'person',
        personId: context.session.personId,
        actorId: context.session.actorId,
      },
      subjects: subjectsOf(context.session),
    },
  };
}

const isOutcome = (value: object): value is HandlerOutcome => !('request' in value);

export async function topUpOnRun(
  tx: TenantQuery,
  context: CommandContext,
  fields: {
    readonly recordId: unknown;
    readonly runId: unknown;
    readonly amountMinor: unknown;
    readonly currency: unknown;
  },
): Promise<HandlerOutcome> {
  const found = await runOnTask(tx, context, fields.recordId, fields.runId, 'gone');
  if (isOutcome(found)) return found;
  // The runtime checks both by value (a whole number above zero, a
  // three-letter code) and answers in its own words; a wrong kind is handed
  // on as a value it refuses, never coerced.
  const result = await topUpAtBudgetStop(tx, {
    ...found.request,
    amountMinor: typeof fields.amountMinor === 'number' ? fields.amountMinor : Number.NaN,
    currency: typeof fields.currency === 'string' ? fields.currency : '',
  });
  if (!result.ok) return refused(result.refusal);
  const outcome = result.value;
  return applied(
    found.taskId,
    null,
    outcome.state === 'applied'
      ? {
          runId: found.request.runId,
          state: 'applied',
          answerId: outcome.answerId,
          heldMinor: outcome.heldMinor,
        }
      : {
          runId: found.request.runId,
          state: 'awaiting_second',
          approvalId: outcome.approvalId,
          thresholdMinor: outcome.thresholdMinor,
        },
  );
}

export async function endOnRun(
  tx: TenantQuery,
  context: CommandContext,
  fields: { readonly recordId: unknown; readonly runId: unknown },
): Promise<HandlerOutcome> {
  const found = await runOnTask(tx, context, fields.recordId, fields.runId, 'reachable');
  if (isOutcome(found)) return found;
  const result = await endAtBudgetStop(tx, found.request);
  if (!result.ok) return refused(result.refusal);
  return applied(found.taskId, null, {
    runId: found.request.runId,
    state: 'cancelled',
    answerId: result.value.answerId,
    releasedMinor: result.value.releasedMinor,
    spentMinor: result.value.spentMinor,
  });
}
