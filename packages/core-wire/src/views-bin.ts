// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.bin`'s answer (#2346), apart from `views.ts` to keep that file under
// the product line limit.

/** One delete, at the task the person deleted; its subtasks went with it. */
export interface TaskBinRow {
  /** What `task.restore` takes to bring the task and its subtasks back. */
  readonly batchId: string;
  readonly taskId: string;
  readonly key: string;
  readonly title: string;
  readonly deletedAt: string;
  /** The deleter's name, or what an actor with no person is called. */
  readonly deletedBy: string;
}

export interface TaskBinResult {
  readonly ok: true;
  /** Newest delete first, at most the read's page. */
  readonly bin: readonly TaskBinRow[];
  /** Whether older deletes lie past the page. */
  readonly more: boolean;
}
