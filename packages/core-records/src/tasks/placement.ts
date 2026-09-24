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
 * board. A rank is a double, so about fifty halvings of one gap reach two
 * neighbours with no number between them. `task.rank` refuses at that point
 * rather than writing a rank equal to a neighbour's; the first slice has no
 * re-spacing pass, and that is stated here rather than discovered.
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
  /**
   * The board is the one the task is already on (a reparent to the top level
   * keeps it), so it is not looked up again. A board the caller names is.
   */
  readonly boardIsTheTasksOwn?: boolean;
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
    const board = request.board ?? null;
    // A board the caller names must be a live task here, as `task.move` and
    // `task.board` require: one that is not would write a task no board read
    // lists, reachable only by someone who already holds its id.
    if (board !== null && request.boardIsTheTasksOwn !== true) {
      const found = await tx.query<{ readonly id: string }>(
        `select id from records
          where business_id = $1 and record_type_id = $2 and id = $3 and deleted_at is null`,
        [tx.businessId, taskTypeId, board],
      );
      if (found.length === 0) {
        return refuse('NOT_FOUND', ['board'], ['No board carries that identifier here.']);
      }
    }
    return {
      board,
      boardSection: request.boardSection ?? null,
      boardRank: await rankAfterSiblings(tx, taskTypeId, null, board),
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
 * Serialise every rank decision in one sibling set: the tasks under one
 * parent, or the top-level tasks on one board. Two creates, or two
 * `task.rank`s, reading the same siblings at once would otherwise compute the
 * same number. Held to the end of the transaction, like the reparent lock.
 */
export async function lockSiblings(
  tx: TenantQuery,
  parentId: string | null,
  board: string | null,
): Promise<void> {
  const set = parentId === null ? `board:${board ?? 'none'}` : `parent:${parentId}`;
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `task.siblings:${tx.businessId}:${set}`,
  ]);
}

/** One sibling's rank, and whether it is in the working set or the trash. */
export interface SiblingRank {
  readonly rank: number;
  readonly live: boolean;
}

/**
 * The rows of one sibling set, live and trashed, as two branches: each can use
 * its own partial index (the slot index for the live rows, the trash-batch
 * index for the trashed ones), which one predicate over both could not.
 * Placeholders from `$3` on are the set's; the caller's extra ones follow.
 */
function siblingRows(set: { readonly parentId: string | null; readonly board: string | null }): {
  readonly live: string;
  readonly trashed: string;
  readonly params: readonly (string | null)[];
} {
  const where =
    set.parentId !== null
      ? `${PARENT} = $3::uuid`
      : set.board !== null
        ? `${PARENT} is null and ${BOARD} = $3::uuid`
        : `${PARENT} is null and ${BOARD} is null and $3::uuid is null`;
  const common = `business_id = $1 and record_type_id = $2 and ${where}`;
  return {
    live: `${common} and deleted_at is null`,
    trashed: `${common} and trash_batch_id is not null`,
    params: [set.parentId ?? set.board],
  };
}

/**
 * The ranks in one sibling set strictly between `above` and `below` (null is
 * open), trashed rows included, leaving out `exceptId` (the task being
 * ranked). A trashed sibling keeps its rank and comes back with it, so a rank
 * chosen now must not land on it either.
 */
export async function siblingRanks(
  tx: TenantQuery,
  taskTypeId: string,
  set: { readonly parentId: string | null; readonly board: string | null },
  between: { readonly above: number | null; readonly below: number | null },
  exceptId: string,
): Promise<readonly SiblingRank[]> {
  const rows = siblingRows(set);
  const range = `${BOARD_RANK} > coalesce($4::numeric, '-Infinity')
                 and ${BOARD_RANK} < coalesce($5::numeric, 'Infinity') and id <> $6`;
  const ranks = await tx.query<{ readonly rank: string; readonly live: boolean }>(
    `select ${BOARD_RANK}::text as rank, true as live from records where ${rows.live} and ${range}
     union all
     select ${BOARD_RANK}::text, false from records where ${rows.trashed} and ${range}`,
    [tx.businessId, taskTypeId, ...rows.params, between.above, between.below, exceptId],
  );
  return ranks.map((row) => ({ rank: Number(row.rank), live: row.live }));
}

/**
 * After the last sibling.
 *
 * Siblings are the tasks under the same parent, or — for a top-level task —
 * the tasks on the same board with no parent. Trashed rows count: a trashed
 * task keeps its rank and a restore brings it back with it, so a new task
 * ranked only against the working set would tie with it. The set is locked
 * first, so two creates in it cannot read the same last rank.
 */
async function rankAfterSiblings(
  tx: TenantQuery,
  taskTypeId: string,
  parentId: string | null,
  board: string | null,
): Promise<number> {
  await lockSiblings(tx, parentId, board);
  const rows = siblingRows({ parentId, board });
  const found = await tx.query<{ readonly last: string | null }>(
    `select max(last)::text as last from (
       select max(${BOARD_RANK}) as last from records where ${rows.live}
       union all
       select max(${BOARD_RANK}) from records where ${rows.trashed}
     ) both_sets`,
    [tx.businessId, taskTypeId, ...rows.params],
  );
  const last = found[0]?.last;
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
