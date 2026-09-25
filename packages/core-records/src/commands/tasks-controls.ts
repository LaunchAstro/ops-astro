// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.cancel` and `task.restart`: the work controls, as commands over the
// runtime functions that own them.
//
// Cancel and restart name the task and the lineage on it. The envelope has
// already asked the declaration's `write` on tasks, the work-control authority
// `task.propose` asks; here the task is found in this business and the lineage
// is checked against it, so authority on one task never reaches a lineage on
// another (R3's rule, the one `propose` enforces). Neither writes the task
// record, which is why neither takes an `expectedRevision`.

import type { TenantQuery } from '../tenancy/database.ts';
import { subjectsOf } from '../authority/grants.ts';
import { cancelAndClassify, restart } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { isUuid } from '../tenancy/ids.ts';
import { fromReasoned, refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { EXPIRY_FIX, expiryFrom } from './expiry.ts';

const REASON_LIMIT = 500;

/**
 * The task and the lineage on it, or the refusal that says which is wrong.
 *
 * `trashed` says whether a task in the trash still answers. Cancel reaches
 * one: it only makes the lineage terminal and releases what it holds
 * (RUNTIME.md, "Cancellation"), and trash does not end an approved lineage,
 * so a trashed task's hold would otherwise stay counted against the cap with
 * no control left to release it. Restart does not: it opens new work, and a
 * trashed task is gone to the work surface until its batch is restored.
 */
async function lineageOnTask(
  tx: TenantQuery,
  context: CommandContext,
  recordId: unknown,
  lineageId: unknown,
  trashed: 'reachable' | 'gone',
): Promise<{ readonly taskId: string; readonly lineageId: string } | HandlerOutcome> {
  // Absent is the body's shape, and is said so; present and malformed is an
  // identifier that names nothing, and answers as one.
  const absent = [
    ...(typeof recordId === 'string' ? [] : ['recordId']),
    ...(typeof lineageId === 'string' ? [] : ['lineageId']),
  ];
  if (absent.length > 0) {
    return refused(
      refuseCommand('COMMAND_BODY_INVALID', absent, ['Name the task and the lineage on it.']),
    );
  }
  if (!isUuid(recordId)) {
    return refused(refuseNotFound());
  }
  // Final review R2-AUTHORITY-33. The queries cast to uuid, which accepts any
  // case and answers lower-case; the lineage's task is then compared as a
  // string. One spelling from here, so an upper-case id is the same task.
  const taskId = recordId.toLowerCase();
  const tasks = await tx.query<{ readonly id: string }>(
    `select id from public.records
      where business_id = $1 and record_type_id = $2 and id = $3
        and ($4 or deleted_at is null)`,
    [tx.businessId, context.spine.taskTypeId, taskId, trashed === 'reachable'],
  );
  if (tasks[0] === undefined) return refused(refuseNotFound());
  if (!isUuid(lineageId)) {
    return refused({ ...refuseNotFound(), names: ['lineageId'] });
  }
  const lineages = await tx.query<{ readonly task_id: string }>(
    `select task_id from public.proposal_lineages where business_id = $1 and id = $2`,
    [tx.businessId, lineageId],
  );
  const lineage = lineages[0];
  if (lineage === undefined) {
    return refused({ ...refuseNotFound(), names: ['lineageId'] });
  }
  if (lineage.task_id !== taskId) {
    return refused(
      refuseCommand(
        'LINEAGE_NOT_ON_TASK',
        ['lineageId'],
        ['Name the task the lineage was opened on.'],
      ),
    );
  }
  return { taskId, lineageId: lineageId.toLowerCase() };
}

const isOutcome = (value: object): value is HandlerOutcome => !('taskId' in value);

export async function cancelOnTask(
  tx: TenantQuery,
  context: CommandContext,
  fields: { readonly recordId: unknown; readonly lineageId: unknown; readonly reason: unknown },
): Promise<HandlerOutcome> {
  const reason = fields.reason;
  if (typeof reason !== 'string' || reason.trim() === '' || reason.length > REASON_LIMIT) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['reason'],
        [
          `Say why, in 1 to ${REASON_LIMIT} characters. It is recorded as the lineage's terminal reason.`,
        ],
      ),
    );
  }
  const found = await lineageOnTask(tx, context, fields.recordId, fields.lineageId, 'reachable');
  if (isOutcome(found)) return found;

  // Final review R2-RUNTIME-5: the envelope's write check ran before any
  // lock, so the runtime holds the grant and reads it again under its locks.
  const result = await cancelAndClassify(tx, {
    lineageId: found.lineageId,
    reason,
    authority: {
      subjects: subjectsOf(context.session),
      collection: context.declaration.collection,
      taskId: found.taskId,
    },
  });
  if (!result.ok) return refused(fromReasoned(result.refusal));
  return applied(found.taskId, null, {
    lineageId: found.lineageId,
    state: 'cancelled',
    reservations: result.value.map((one) => ({
      reservationId: one.reservationId,
      state: one.state,
      released: one.released,
    })),
  });
}

export async function restartOnTask(
  tx: TenantQuery,
  context: CommandContext,
  fields: {
    readonly recordId: unknown;
    readonly lineageId: unknown;
    readonly expiresInSeconds?: unknown;
  },
): Promise<HandlerOutcome> {
  const expiresAt = expiryFrom(fields.expiresInSeconds);
  if (expiresAt === undefined) {
    return refused(refuseCommand('FIELD_VALUE_INVALID', ['expiresInSeconds'], [EXPIRY_FIX]));
  }
  const found = await lineageOnTask(tx, context, fields.recordId, fields.lineageId, 'gone');
  if (isOutcome(found)) return found;

  const result = await restart(tx, {
    taskId: found.taskId,
    collection: context.declaration.collection,
    lineageId: found.lineageId,
    proposedByActorId: context.session.actorId,
    subjects: subjectsOf(context.session),
    expiresAt,
  });
  if (!result.ok) return refused(fromReasoned(result.refusal));
  return applied(found.taskId, null, {
    lineageId: result.value.lineageId,
    restartsLineageId: result.value.restartsLineageId,
    versionId: result.value.versionId,
    version: result.value.version,
    gateId: result.value.gateId,
    payloadDigest: result.value.payloadDigest,
  });
}
