// SPDX-License-Identifier: AGPL-3.0-only
//
// Where a new task goes, and who decides.
//
// The legacy had a placement helper that filled defaults, avoided giving a
// subtask a board section and placed a new task after its siblings — and
// several creation routes bypassed it (specification, 14.2). The new core has
// five entry points from the start, so placement is not a helper callers are
// expected to remember. It is three things: a check constraint in the
// database, one owning operation per protected field, and this module, which
// derives the rest rather than reading it from a request body.
//
// Nothing here writes. Each function returns what the server decided, or a
// refusal, and the command that called it writes once.

import type { TenantQuery } from '../tenancy/database.ts';
import { refuse, type RecordsRefusal } from '../records/refusals.ts';
import { slotOf, TASK_SPINE } from './spine.ts';

const PARENT = slotOf(TASK_SPINE, 'parent');
const BOARD = slotOf(TASK_SPINE, 'board');
const BOARD_RANK = slotOf(TASK_SPINE, 'board_rank');
const KEY = slotOf(TASK_SPINE, 'key');

/**
 * The distance between two neighbours. Ranks are spaced so `task.rank` can put
 * a task between two others by taking their midpoint, without renumbering a
 * board. Ten thousand insertions between one pair exhausts the gap and needs a
 * re-spacing pass; the first slice does not have one, and that is stated here
 * rather than discovered.
 */
export const RANK_GAP = 1000;

/** The fields a create payload may not carry, because the server derives them. */
export const DERIVED_ON_CREATE: readonly string[] = ['board_rank'];

export interface TaskPlacementRequest {
  /** Null for a top-level task. */
  readonly parentId: string | null;
  /** Only read for a top-level task; a subtask inherits its parent's. */
  readonly board?: string | null;
  readonly boardSection?: string | null;
  /** The keys the caller actually supplied, so a supplied `board_rank` is seen. */
  readonly suppliedKeys?: readonly string[];
}

export interface TaskPlacement {
  readonly board: string | null;
  readonly boardSection: string | null;
  readonly boardRank: number;
}

interface ParentRow {
  readonly board: string | null;
  readonly deleted_at: Date | null;
  readonly trash_batch_id: string | null;
}

/**
 * Where a new task lands.
 *
 * For a subtask all three answers are derived and none is read from the
 * request: the board is inherited, the section is forced empty, and the rank
 * is after the last sibling (specification, 14.2 point 2). For a top-level
 * task the board and section are the caller's — placing a task in a container
 * is ordinary — and only the rank is the server's.
 */
export async function planTaskPlacement(
  tx: TenantQuery,
  taskTypeId: string,
  request: TaskPlacementRequest,
): Promise<TaskPlacement | RecordsRefusal> {
  const supplied = request.suppliedKeys ?? [];
  const derived = DERIVED_ON_CREATE.filter((key) => supplied.includes(key));
  if (derived.length > 0) {
    return refuse('PLACEMENT_IS_DERIVED', derived, [
      'Placement is the server’s. A create payload cannot choose a rank.',
      'Call task.rank with the neighbours to move a task, so two clients reordering at once cannot arrive at the same number by arithmetic.',
    ]);
  }

  if (request.parentId === null || request.parentId === undefined) {
    return {
      board: request.board ?? null,
      boardSection: request.boardSection ?? null,
      boardRank: await rankAfterSiblings(tx, taskTypeId, null, request.board ?? null),
    };
  }

  // A subtask carrying a board section is refused before the constraint sees
  // it, so the caller is told which field was wrong rather than being handed a
  // constraint name.
  if (request.boardSection !== null && request.boardSection !== undefined) {
    return refuse(
      'PLACEMENT_IS_DERIVED',
      ['board_section'],
      [
        'A subtask sits under its parent, not in a board section.',
        'Its board is inherited from the parent, and its section is empty.',
      ],
    );
  }

  const parent = await readParent(tx, taskTypeId, request.parentId);
  if (parent === undefined) {
    return refuse(
      'NOT_FOUND',
      ['parent'],
      ['No task of this type carries that identifier in this business.'],
    );
  }
  if (parent.deleted_at !== null) {
    return refuse(
      'PARENT_TRASHED',
      ['parent', parent.trash_batch_id ?? ''],
      ['The parent is in the trash. Restore its batch before adding to it.'],
    );
  }

  return {
    board: parent.board,
    boardSection: null,
    boardRank: await rankAfterSiblings(tx, taskTypeId, request.parentId, parent.board),
  };
}

/**
 * Locked `for share` (a trash updates non-key columns, so not `for key share`):
 * a trash of the parent then waits and takes the new child into its batch, or
 * the child waits for the trash and is refused `PARENT_TRASHED`.
 */
async function readParent(
  tx: TenantQuery,
  taskTypeId: string,
  parentId: string,
): Promise<ParentRow | undefined> {
  const rows = await tx.query<ParentRow>(
    `select ${BOARD} as board, deleted_at, trash_batch_id from records
      where business_id = $1 and record_type_id = $2 and id = $3
        for share`,
    [tx.businessId, taskTypeId, parentId],
  );
  return rows[0];
}

/**
 * Would putting `taskId` under `parentId` close a loop, at any depth? Only a
 * reparent writes `parent` on an existing task, so reparents are serialised per
 * business by the advisory lock, and the walk, a later statement, sees what the
 * other committed under read committed. A row seen before ends the walk.
 */
export async function wouldCloseParentLoop(
  tx: TenantQuery,
  taskTypeId: string,
  taskId: string,
  parentId: string,
): Promise<boolean> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `task.reparent:${tx.businessId}`,
  ]);
  const rows = await tx.query<{ readonly reaches: boolean }>(
    `with recursive up (id, parent) as (
       select id, ${PARENT} from records
        where business_id = $1 and record_type_id = $2 and id = $3
       union all
       select r.id, r.${PARENT} from records r join up on r.id = up.parent
        where r.business_id = $1 and r.record_type_id = $2
     ) cycle id set looped using path
     select exists (select 1 from up where id = $4) as reaches`,
    [tx.businessId, taskTypeId, parentId, taskId],
  );
  return rows[0]?.reaches === true;
}

/**
 * After the last sibling.
 *
 * Siblings are the tasks under the same parent, or — for a top-level task —
 * the tasks on the same board with no parent. Trashed rows are excluded, so a
 * task that comes back from the trash keeps a rank that no longer collides,
 * and the working set is the only thing that decides order.
 */
async function rankAfterSiblings(
  tx: TenantQuery,
  taskTypeId: string,
  parentId: string | null,
  board: string | null,
): Promise<number> {
  const rows =
    parentId === null
      ? await tx.query<{ readonly last: string | null }>(
          `select max(${BOARD_RANK})::text as last from records
            where business_id = $1 and record_type_id = $2 and deleted_at is null
              and ${PARENT} is null and ${BOARD} is not distinct from $3`,
          [tx.businessId, taskTypeId, board],
        )
      : await tx.query<{ readonly last: string | null }>(
          `select max(${BOARD_RANK})::text as last from records
            where business_id = $1 and record_type_id = $2 and deleted_at is null
              and ${PARENT} = $3`,
          [tx.businessId, taskTypeId, parentId],
        );
  const last = rows[0]?.last;
  return last === null || last === undefined ? RANK_GAP : Number(last) + RANK_GAP;
}

/**
 * The next task key for this business.
 *
 * `key` is system-classified and assigned once (minimum contract, 5.2), so
 * something has to produce it and no request body may. There is no per-business
 * sequence, because creating one per business would be runtime DDL, and one
 * installation-wide sequence would let each tenant read the others' volume off
 * the gaps in its own numbering.
 *
 * So the number is the highest this business has used, plus one, read inside
 * the caller's transaction. Two concurrent creates can choose the same number;
 * the loser is refused by `record_unique_values`, because `key` is a unique
 * field, and the command retries. That is a real cost and it is the honest
 * one: the claim table is the arbiter, and a duplicate key is refused rather
 * than written.
 */
export async function nextTaskKey(tx: TenantQuery, taskTypeId: string): Promise<string> {
  const rows = await tx.query<{ readonly last: string | null }>(
    `select max((regexp_match(${KEY}, '^T-([0-9]+)$'))[1]::bigint)::text as last
       from records where business_id = $1 and record_type_id = $2`,
    [tx.businessId, taskTypeId],
  );
  const last = rows[0]?.last;
  return `T-${last === null || last === undefined ? 1 : Number(last) + 1}`;
}

/** Who is acting. The actor kind is the authenticated actor's, never a body's. */
export type ActorKind = 'person' | 'agent' | 'system' | 'external_party' | 'integration';

/** Where the call came in. One per surface, plus the two machine entrances. */
export type EntryPoint = 'app' | 'api' | 'cli' | 'automation' | 'import';

/**
 * `source` is derived from the authenticated actor kind and the entry point
 * (ADR 0037:18), which is exactly what this function is: the two facts the
 * server already holds, joined, with nothing from the request. A body carrying
 * `source` is refused `SOURCE_SPOOFED` by the command, and the attempted value
 * goes to the audit rather than to the response.
 */
export function deriveSource(actorKind: ActorKind, entryPoint: EntryPoint): string {
  return `${actorKind}:${entryPoint}`;
}

/**
 * The completion stamp, as a projection of the state rather than a field.
 *
 * There is exactly one writer and exactly one clearer and they are the same
 * pair of operations, so the precedence question 14.1 asks does not arise:
 * `task.complete` moves the state to a completed category and this returns the
 * stamp; `task.reopen` moves it away and this returns null, which the command
 * writes by removing the key from `data`. Nothing else touches the field on
 * any surface, and a create or update payload carrying it is refused
 * `FIELD_NOT_WRITABLE`.
 *
 * Reopen clears the field and does not clear the history: the completion event
 * stays in the audit and in the record's history with its actor and time. The
 * stamp is a projection of the current state; the evidence that the task was
 * once complete is not.
 */
export function completionStampFor(machineCategory: string, now: Date): Date | null {
  return machineCategory === 'completed' ? now : null;
}

/**
 * A payload merged into a record's `data`, keeping the distinction the legacy
 * had and specification 14.2 asks to carry: **an explicitly supplied null is
 * honoured as a null rather than overwritten by a default, and a field absent
 * from the payload keeps what it had.** "Clear the due date" and "do not change
 * the due date" are different requests and a merge that cannot tell them apart
 * silently performs the wrong one.
 *
 * A cleared field is **removed** from `data` rather than set to JSON null. Both
 * project to an empty slot, so the difference is not observable through a
 * filter, and a record that stops carrying a key is easier to read than one
 * carrying a key whose value means "not set".
 *
 * It is pure, and it does not decide what a caller may write: the classification
 * refusal is `refuseGenericWrite`'s and runs before this. The command that owns
 * the write calls both.
 */
export function mergeFieldValues(
  existing: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(payload)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}
