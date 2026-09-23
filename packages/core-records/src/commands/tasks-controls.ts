// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.cancel`, `task.restart` and `task.heartbeat`: the work controls, as
// commands over the runtime functions that own them.
//
// Cancel and restart name the task and the lineage on it. The envelope has
// already asked the declaration's `write` on tasks, the work-control authority
// `task.propose` asks; here the task is found in this business and the lineage
// is checked against it, so authority on one task never reaches a lineage on
// another (R3's rule, the one `propose` enforces). Neither writes the task
// record, which is why neither takes an `expectedRevision`.
//
// The heartbeat is the agent's. The person path refuses it in `handlers.ts`
// as it refuses pickup and handback; the agent path reaches `heartbeatLease`
// with the actor and delegation its credential resolved to.

import type { TenantQuery } from '../tenancy/database.ts';
import { subjectsOf } from '../authority/grants.ts';
import {
  cancelAndClassify,
  heartbeat,
  MAXIMUM_RENEWAL_SECONDS,
  restart,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { expiryFrom, fromRuntime } from './tasks-runtime.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const NOT_FOUND_FIXES: readonly string[] = ['Check the identifier against the one you were given.'];
const REASON_LIMIT = 500;

/** The task and the lineage on it, or the refusal that says which is wrong. */
async function lineageOnTask(
  tx: TenantQuery,
  context: CommandContext,
  recordId: unknown,
  lineageId: unknown,
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
  if (typeof recordId !== 'string' || !UUID.test(recordId)) {
    return refused(refuseCommand('NOT_FOUND', [], NOT_FOUND_FIXES));
  }
  const tasks = await tx.query<{ readonly id: string }>(
    `select id from public.records
      where business_id = $1 and record_type_id = $2 and id = $3 and deleted_at is null`,
    [tx.businessId, context.spine.taskTypeId, recordId],
  );
  if (tasks[0] === undefined) return refused(refuseCommand('NOT_FOUND', [], NOT_FOUND_FIXES));
  if (typeof lineageId !== 'string' || !UUID.test(lineageId)) {
    return refused(refuseCommand('NOT_FOUND', ['lineageId'], NOT_FOUND_FIXES));
  }
  const lineages = await tx.query<{ readonly task_id: string }>(
    `select task_id from public.proposal_lineages where business_id = $1 and id = $2`,
    [tx.businessId, lineageId],
  );
  const lineage = lineages[0];
  if (lineage === undefined) {
    return refused(refuseCommand('NOT_FOUND', ['lineageId'], NOT_FOUND_FIXES));
  }
  if (lineage.task_id !== recordId) {
    return refused(
      refuseCommand(
        'LINEAGE_NOT_ON_TASK',
        ['lineageId'],
        ['Name the task the lineage was opened on.'],
      ),
    );
  }
  return { taskId: recordId, lineageId };
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
  const found = await lineageOnTask(tx, context, fields.recordId, fields.lineageId);
  if (isOutcome(found)) return found;

  const result = await cancelAndClassify(tx, { lineageId: found.lineageId, reason });
  if (!result.ok) return refused(fromRuntime(result.refusal));
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
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['expiresInSeconds'],
        ['Name a whole number of seconds greater than zero, or leave it out for a week.'],
      ),
    );
  }
  const found = await lineageOnTask(tx, context, fields.recordId, fields.lineageId);
  if (isOutcome(found)) return found;

  const result = await restart(tx, {
    taskId: found.taskId,
    collection: context.declaration.collection,
    lineageId: found.lineageId,
    proposedByActorId: context.session.actorId,
    subjects: subjectsOf(context.session),
    expiresAt,
  });
  if (!result.ok) return refused(fromRuntime(result.refusal));
  return applied(found.taskId, null, {
    lineageId: result.value.lineageId,
    restartsLineageId: result.value.restartsLineageId,
    versionId: result.value.versionId,
    version: result.value.version,
    gateId: result.value.gateId,
    payloadDigest: result.value.payloadDigest,
  });
}

const DEFAULT_RENEWAL_SECONDS = 15 * 60;

export async function heartbeatLease(
  tx: TenantQuery,
  fields: { readonly leaseId: unknown; readonly fence: unknown; readonly leaseSeconds?: unknown },
  holderActorId: string,
  delegationId: string,
): Promise<HandlerOutcome> {
  const seconds = fields.leaseSeconds ?? DEFAULT_RENEWAL_SECONDS;
  if (
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > MAXIMUM_RENEWAL_SECONDS
  ) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['leaseSeconds'],
        [`Name a whole number of seconds from 1 to ${MAXIMUM_RENEWAL_SECONDS}, or leave it out.`],
      ),
    );
  }
  if (typeof fields.fence !== 'number' || !Number.isSafeInteger(fields.fence)) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', ['fence'], ['Send the fence the pickup handed back.']),
    );
  }
  if (typeof fields.leaseId !== 'string' || !UUID.test(fields.leaseId)) {
    return refused(refuseCommand('LEASE_NOT_OWNED', [], ['Renew the lease this pickup issued.']));
  }
  const result = await heartbeat(tx, {
    leaseId: fields.leaseId,
    fence: fields.fence,
    holderActorId,
    delegationId,
    renewSeconds: seconds,
  });
  if (!result.ok) return refused(fromRuntime(result.refusal));
  return applied(result.value.taskId, null, {
    leaseId: result.value.leaseId,
    fence: result.value.fence,
    expiresAt: result.value.expiresAt.toISOString(),
  });
}
