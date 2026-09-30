// SPDX-License-Identifier: AGPL-3.0-only
//
// `run.revise_state`: a run's current knowledge and unknowns, kept as a new
// version with the actor who revised it (MP-6-2, CS-16.4). The agent page's
// only write. `run:write` on the named task has been asked by the envelope, a
// person's grant or, on the agent prefix, the delegation's (ORCH33, ORCH34);
// here the task is found in this business and the run is checked against it,
// so authority on one task never reaches a run on another. The run's row is
// locked while its newest version is read, so two revisions of one version
// are one applied and one `VERSION_STALE`. Nothing activates from the lists
// in version 1 (RA-10): they are the writer's text, kept and shown.

import { randomUUID } from 'node:crypto';
import { isUuid } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';

/** The most items in either list, and the longest item, in characters. */
const MAXIMUM_ITEMS = 50;
const MAXIMUM_ITEM_LENGTH = 2000;

const LIST_FIXES: readonly string[] = [
  `Send knowledge and unknowns as lists of up to ${MAXIMUM_ITEMS} non-empty texts, each at most ${MAXIMUM_ITEM_LENGTH} characters.`,
];

const VERSION_FIXES: readonly string[] = ['Read the run again, then revise the version it shows.'];

interface Revision {
  readonly expectedVersion: unknown;
  readonly knowledge: unknown;
  readonly unknowns: unknown;
}

const isItemList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) &&
  value.length <= MAXIMUM_ITEMS &&
  value.every(
    (item) => typeof item === 'string' && item.trim() !== '' && item.length <= MAXIMUM_ITEM_LENGTH,
  );

/**
 * The revision on the run the task names, as `actorId`: the person, or the
 * agent working under its delegation. `taskId` is the id the authority check
 * was asked of, as sent.
 */
export async function reviseRunState(
  tx: TenantQuery,
  taskTypeId: string,
  target: { readonly taskId: unknown; readonly runId: unknown },
  revision: Revision,
  actorId: string,
): Promise<HandlerOutcome> {
  const { taskId, runId } = target;
  const absent = [
    ...(typeof taskId === 'string' ? [] : ['recordId']),
    ...(typeof runId === 'string' ? [] : ['runId']),
  ];
  if (absent.length > 0) {
    return refused(
      refuseCommand('COMMAND_BODY_INVALID', absent, ['Name the task and the run on it.']),
    );
  }
  const malformed = [
    ...(isItemList(revision.knowledge) ? [] : ['knowledge']),
    ...(isItemList(revision.unknowns) ? [] : ['unknowns']),
  ];
  const { expectedVersion } = revision;
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  ) {
    malformed.push('expectedVersion');
  }
  if (malformed.length > 0) {
    return refused(refuseCommand('COMMAND_BODY_INVALID', malformed, LIST_FIXES));
  }
  if (!isUuid(taskId)) return refused(refuseNotFound());
  const task = taskId.toLowerCase();
  // A task in the trash is gone from the work surface, and so is its run.
  const tasks = await tx.query<{ readonly id: string }>(
    `select id from public.records
      where business_id = $1 and record_type_id = $2 and id = $3 and deleted_at is null`,
    [tx.businessId, taskTypeId, task],
  );
  if (tasks[0] === undefined) return refused(refuseNotFound());
  if (!isUuid(runId)) return refused(refuseNotFound(['runId']));
  // Locked before its newest version is read: one revision per version. No
  // run, and a run on another task, are one answer, and neither is locked:
  // the caller's authority is on the task they named, and says nothing about
  // any other.
  const runs = await tx.query<{ readonly id: string }>(
    `select id from public.planned_runs
      where business_id = $1 and id = $2 and task_id = $3 for update`,
    [tx.businessId, runId, task],
  );
  if (runs[0] === undefined) return refused(refuseNotFound(['runId']));
  const run = runId.toLowerCase();
  const newest = await tx.query<{ readonly version: number }>(
    `select coalesce(max(version), 0)::int as version from public.run_states
      where business_id = $1 and run_id = $2`,
    [tx.businessId, run],
  );
  const current = newest[0]?.version ?? 0;
  if (current !== expectedVersion) {
    return refused(refuseCommand('VERSION_STALE', [`version=${current}`], VERSION_FIXES));
  }
  const version = current + 1;
  await tx.query(
    `insert into public.run_states
       (business_id, id, run_id, task_id, version, knowledge, unknowns, revised_by_actor_id)
     values ($1, $2, $3, $4, $5, $6::text::jsonb, $7::text::jsonb, $8)`,
    [
      tx.businessId,
      randomUUID(),
      run,
      task,
      version,
      JSON.stringify(revision.knowledge),
      JSON.stringify(revision.unknowns),
      actorId,
    ],
  );
  return applied(task, null, { runId: run, version });
}

export async function reviseStateOnRun(
  tx: TenantQuery,
  context: CommandContext,
  fields: {
    readonly recordId: unknown;
    readonly runId: unknown;
    readonly expectedVersion: unknown;
    readonly knowledge: unknown;
    readonly unknowns: unknown;
  },
): Promise<HandlerOutcome> {
  return await reviseRunState(
    tx,
    context.spine.taskTypeId,
    { taskId: fields.recordId, runId: fields.runId },
    fields,
    context.session.actorId,
  );
}
