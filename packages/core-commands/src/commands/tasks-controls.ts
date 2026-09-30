// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.cancel` and `task.restart`: the work controls, as commands over the
// runtime functions that own them.
//
// Cancel and restart name the task and the lineage on it. Each is a person's
// decision (T3a, `T3 decide authority`): the envelope has already asked the
// declaration's `decide` on tasks, and an agent never holds it. Here the task
// is found in this business and the lineage is checked against it, so
// authority on one task never reaches a lineage on another (R3's rule, the one
// `propose` enforces), and `decide` is asked again with the grants held.
// Neither writes the task record, which is why neither takes an
// `expectedRevision`.

import {
  isUuid,
  raiseDecision,
  raiseIncident,
  subjectsOf,
  withdrawEndedGates,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import {
  cancelAndClassify,
  checkAuthorityAt,
  holdCoveringGrants,
  lockedInstant,
  restart,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
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
  // The queries cast to uuid, which accepts any
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
    return refused(refuseNotFound(['lineageId']));
  }
  const lineages = await tx.query<{ readonly task_id: string }>(
    `select task_id from public.proposal_lineages where business_id = $1 and id = $2`,
    [tx.businessId, lineageId],
  );
  const lineage = lineages[0];
  if (lineage === undefined) {
    return refused(refuseNotFound(['lineageId']));
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

/**
 * `decide` on the task, asked with the caller's grants held for share, as
 * `decide` holds its own before its locks: a revocation that committed first
 * is seen here, and one that comes second waits for this transaction. Asked at
 * the clock after the hold, so a grant that lapsed while this waited no longer
 * counts. The envelope's check ran before any of this.
 */
async function decideHeld(
  tx: TenantQuery,
  context: CommandContext,
  taskId: string,
): Promise<HandlerOutcome | null> {
  const subjects = subjectsOf(context.session);
  await holdCoveringGrants(tx, subjects, context.declaration.collection);
  const current = await checkAuthorityAt(
    tx,
    subjects,
    {
      collection: context.declaration.collection,
      action: 'decide',
      scope: { kind: 'record', id: taskId },
    },
    await lockedInstant(tx),
  );
  if (current.ok) return null;
  return refused(
    refuseCommand(
      'SCOPE_NOT_GRANTED',
      [],
      ['A person with decide authority on this task stops or restarts its work.'],
    ),
  );
}

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
  const undecided = await decideHeld(tx, context, found.taskId);
  if (undecided !== null) return undecided;

  // The envelope's write check runs before any lock, so the runtime holds
  // the grant and reads it again under its locks.
  const result = await cancelAndClassify(tx, {
    lineageId: found.lineageId,
    reason,
    authority: {
      subjects: subjectsOf(context.session),
      collection: context.declaration.collection,
      taskId: found.taskId,
      alsoDecide: true,
    },
  });
  if (!result.ok) return refused(result.refusal);
  await raiseIncident(tx, result.value);
  // INB-1: the cancelled lineage's pending gate can no longer be decided.
  await withdrawEndedGates(tx, found.taskId);
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

/**
 * T3a: a restart opens a new envelope. The task's open one keeps its settled
 * spend and funds nothing new: it is closed here, under the envelope lock
 * `propose` took for it, so the new lineage's approval opens its own. The
 * cap still counts what it holds and spent, and a hold still in flight
 * settles against it by id.
 */
async function closeOpenEnvelope(tx: TenantQuery, taskId: string): Promise<void> {
  await tx.query(
    `update public.task_envelopes set state = 'closed', closed_at = now()
      where business_id = $1 and task_id = $2 and state = 'open'`,
    [tx.businessId, taskId],
  );
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
  const undecided = await decideHeld(tx, context, found.taskId);
  if (undecided !== null) return undecided;

  const result = await restart(tx, {
    taskId: found.taskId,
    collection: context.declaration.collection,
    lineageId: found.lineageId,
    proposedByActorId: context.session.actorId,
    subjects: subjectsOf(context.session),
    expiresAt,
  });
  if (!result.ok) return refused(result.refusal);
  // Decide again now that `propose` holds its locks, at the clock after them:
  // a decide grant that lapsed while the restart waited refuses it, and the
  // command's savepoint takes back what `propose` wrote (as cancel does under
  // its own locks).
  const lapsed = await decideHeld(tx, context, found.taskId);
  if (lapsed !== null) return lapsed;
  await closeOpenEnvelope(tx, found.taskId);
  await raiseDecision(tx, { taskId: found.taskId, gateId: result.value.gateId });
  return applied(found.taskId, null, {
    lineageId: result.value.lineageId,
    restartsLineageId: result.value.restartsLineageId,
    versionId: result.value.versionId,
    version: result.value.version,
    gateId: result.value.gateId,
    payloadDigest: result.value.payloadDigest,
  });
}
