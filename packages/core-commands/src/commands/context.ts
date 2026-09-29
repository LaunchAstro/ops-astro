// SPDX-License-Identifier: AGPL-3.0-only
//
// What a command is handed, held apart from the thing that hands it over.
//
// These three types and `readTaskSpine` are not in `handlers.ts`, beside the
// dispatch, because that would put every command module in a cycle with the
// dispatch that calls it: `handlers.ts` imports `tasks-write.ts` for the work,
// and `tasks-write.ts` would import `handlers.ts` back for the shape of its
// own argument. A cycle has no entry point, and this tree's dependency rules
// refuse one (`.dependency-cruiser.cjs`, `no-circular`), so the shape lives
// here — the module both sides depend on — and the dispatch stays where the
// exported surface check reads it from.

import {
  readTaskStates,
  TASK_TYPE_KEY,
  TASK_STATE_TYPE_KEY,
  COMMENT_TYPE_KEY,
} from '../../../core-records/src/index.ts';
import type {
  TenantQuery,
  Session,
  TaskStateRow,
  EntryPoint,
} from '../../../core-records/src/index.ts';
import type { CommandDeclaration } from '../../../core-wire/src/index.ts';

/** The task type's identifiers, read rather than installed. */
export interface TaskSpine {
  readonly taskTypeId: string;
  readonly taskStateTypeId: string;
  /**
   * The comment type, when this business has one.
   *
   * Optional, and deliberately not part of the pair above: a business seeded
   * before L2 installed `task_comment` has a task spine and no comment type,
   * and `task.comment` refusing `DEPENDENCY_NOT_LANDED` there is a truthful
   * answer where raising would call a missing record type a fault in the
   * caller's request.
   */
  readonly taskCommentTypeId: string | undefined;
  readonly states: readonly TaskStateRow[];
}

/** The record a targeted command was aimed at, read before the handler runs. */
export interface TaskRow {
  readonly id: string;
  readonly revision: number;
  readonly data: Readonly<Record<string, unknown>>;
  readonly deleted_at: Date | null;
  readonly trash_batch_id: string | null;
}

export interface CommandContext {
  readonly session: Session;
  readonly declaration: CommandDeclaration;
  readonly entryPoint: EntryPoint;
  readonly spine: TaskSpine;
  /** Present exactly when the declaration targets an existing record. */
  readonly target: TaskRow | undefined;
}

/**
 * The type's identifiers for this business.
 *
 * It reads and does not install. An installation whose task type is missing is
 * a deployment fault rather than a caller's mistake, so it raises: the audit
 * event records the attempt as failed and the caller gets an error rather than
 * a refusal that suggests they did something wrong.
 */
export async function readTaskSpine(tx: TenantQuery): Promise<TaskSpine> {
  const rows = await tx.query<{ readonly key: string; readonly id: string }>(
    `select key, id from record_types where business_id = $1 and key = any($2::text[])`,
    [tx.businessId, [TASK_TYPE_KEY, TASK_STATE_TYPE_KEY, COMMENT_TYPE_KEY]],
  );
  const taskTypeId = rows.find((row) => row.key === TASK_TYPE_KEY)?.id;
  const taskStateTypeId = rows.find((row) => row.key === TASK_STATE_TYPE_KEY)?.id;
  if (taskTypeId === undefined || taskStateTypeId === undefined) {
    throw new Error(
      'readTaskSpine: this business has no task type. Run installTaskSpine before serving it.',
    );
  }
  return {
    taskTypeId,
    taskStateTypeId,
    taskCommentTypeId: rows.find((row) => row.key === COMMENT_TYPE_KEY)?.id,
    states: await readTaskStates(tx, taskStateTypeId),
  };
}
