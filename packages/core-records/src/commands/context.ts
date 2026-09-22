// SPDX-License-Identifier: AGPL-3.0-only
//
// What a command is handed, held apart from the thing that hands it over.
//
// In the draft these three types and `readTaskSpine` lived in `handlers.ts`,
// beside the dispatch. That put every command module in a cycle with the
// dispatch that calls it: `handlers.ts` imports `tasks-write.ts` for the work,
// and `tasks-write.ts` imported `handlers.ts` back for the shape of its own
// argument. A cycle has no entry point, and this tree's dependency rules refuse
// one (`.dependency-cruiser.cjs`, `no-circular`), so the shape moved here —
// the module both sides depend on — and the dispatch stayed where the exported
// surface check reads it from.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Session } from '../identity/login-resolution.ts';
import type { TaskStateRow } from '../tasks/state.ts';
import { readTaskStates } from '../tasks/state.ts';
import { TASK_TYPE_KEY } from '../tasks/spine.ts';
import { TASK_STATE_TYPE_KEY } from '../tasks/states.ts';
import type { CommandDeclaration } from './surface.ts';
import type { EntryPoint } from '../tasks/placement.ts';

/** The task type's identifiers, read rather than installed. */
export interface TaskSpine {
  readonly taskTypeId: string;
  readonly taskStateTypeId: string;
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
    [tx.businessId, [TASK_TYPE_KEY, TASK_STATE_TYPE_KEY]],
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
    states: await readTaskStates(tx, taskStateTypeId),
  };
}
