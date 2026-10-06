// SPDX-License-Identifier: AGPL-3.0-only
//
// The three commands that move a task: to another parent, to another board, to
// another position.
//
// They are separate operations rather than field writes because each is an
// access change or a derivation the server owns. `parent` is owned by
// `task.reparent` (specification 14.2 point 1), `board` escalates to
// `task.move` because placing a task in a container is a visibility change
// (minimum contract 3.4), and a rank is assigned from neighbours rather than
// taken as a number so two clients reordering at once cannot arrive at the
// same position by arithmetic (14.2 point 3).

import {
  isRecordsRefusal,
  RANK_GAP,
  lockSiblings,
  mergeFieldValues,
  planTaskPlacement,
  rankAfterSiblings,
  siblingRanks,
  wouldCloseParentLoop,
  slotOf,
  TASK_SPINE,
  readFieldDefinitions,
  checkAuthority,
  subjectsOf,
  wayfinderFacts,
} from '../../../core-records/src/index.ts';
import { refuseOwnerTicketMove } from './wayfinder.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { refuseWrongValueType } from './values.ts';
import { refuseReparentOperands } from './operands.ts';
import { refuseOtherClient } from './tasks-party.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';

const PARENT = slotOf(TASK_SPINE, 'parent');
const BOARD = slotOf(TASK_SPINE, 'board');
const BOARD_RANK = slotOf(TASK_SPINE, 'board_rank');
const CLIENT = slotOf(TASK_SPINE, 'client');
const WHOLE_TASKS = {
  collection: 'task',
  action: 'write',
  scope: { kind: 'business', id: null },
} as const;

/**
 * The client a live parent carries, read under the parent's row lock. A
 * `task.set_party` on an empty parent holds that row `for update` until it
 * commits, so this waits and reads the client it commits rather than the one
 * it is replacing; a plain read would let a reparent check against the old
 * client and land one client's subtree under another's parent. `for share`, as
 * `planTaskPlacement` takes the parent next, in the same order: the target,
 * then the parent.
 */
async function lockedClientOf(
  tx: TenantQuery,
  taskTypeId: string,
  parentId: string,
): Promise<string | null> {
  const rows = await tx.query<{ readonly client: string | null }>(
    `select ${CLIENT}::text as client from records
      where business_id = $1 and record_type_id = $2 and id = $3 and deleted_at is null
        for share`,
    [tx.businessId, taskTypeId, parentId],
  );
  return rows[0]?.client ?? null;
}

/**
 * The envelope's question, `write` on `task`, put to another record's own
 * scope: a business grant covers every record and a record grant the one it
 * names. It is asked before that record is looked up, so a caller refused it
 * gets one answer whether the record is unreached, foreign or fabricated.
 */
async function refuseUnreachedRecord(
  tx: TenantQuery,
  context: CommandContext,
  id: string,
): Promise<CommandRefusal | undefined> {
  const reached = await checkAuthority(tx, subjectsOf(context.session), {
    collection: 'task',
    action: 'write',
    scope: { kind: 'record', id },
  });
  return reached.ok ? undefined : reached.refusal;
}

/**
 * A neighbour that is a ticket of the target's own map, under a write grant on
 * that map (W12), never a nested map. The sibling read below asks again, in one
 * statement, that it is still filed under that parent.
 */
async function reachedThroughMap(
  tx: TenantQuery,
  context: CommandContext,
  id: string,
  parent: string | null,
): Promise<boolean> {
  if (parent === null || (await wayfinderFacts(tx, id))?.mapId !== parent) return false;
  return (await refuseUnreachedRecord(tx, context, parent)) === undefined;
}

/**
 * A subtask's board is its parent's (specification 14.2 point 2; 0006's note
 * on `uuid_5`), so a task that changes board takes its whole live subtree with
 * it, or a board read would list subtasks whose root has left and miss the
 * ones whose root arrived.
 *
 * The descendants are found by the walk trash uses, and each is asked the
 * envelope's question at its own record scope, as trash asks it: the target's
 * grant does not reach them. The first uncovered one refuses the whole move.
 *
 * The walk locks what it finds, and is run again until it finds nothing it
 * has not already locked and asked about. A creation holds its parent `for
 * share` until it commits, so a walk parked on that parent sees the new child
 * only on the next pass: the child is asked about then, or refuses the move.
 * Once every row is locked no child can be added under one, so the rewrite
 * touches exactly the rows asked about, and a later creation waits and
 * inherits the new board.
 */
async function carryBoardToDescendants(
  tx: TenantQuery,
  context: CommandContext,
  rootId: string,
  board: string | null,
): Promise<CommandRefusal | undefined> {
  const walk = `with recursive down as (
       select id from records
        where business_id = $1 and record_type_id = $2 and ${PARENT} = $3 and deleted_at is null
       union all
       select child.id from records child join down on child.${PARENT} = down.id
        where child.business_id = $1 and child.record_type_id = $2 and child.deleted_at is null
     ) cycle id set looped using path`;
  const asked: string[] = [];
  let whole: boolean | undefined;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- each pass sees what the last one waited on
    const found = await tx.query<{ readonly id: string }>(
      `${walk}
       select r.id from records r
        where r.business_id = $1 and r.id in (select id from down where not looped and id <> $3)
        for update of r`,
      [tx.businessId, context.spine.taskTypeId, rootId],
    );
    const fresh = found.filter(({ id }) => !asked.includes(id));
    if (fresh.length === 0) break;
    // eslint-disable-next-line no-await-in-loop -- asked once, on the first pass that finds any
    whole ??= (await checkAuthority(tx, subjectsOf(context.session), WHOLE_TASKS)).ok;
    if (!whole) {
      for (const { id } of fresh) {
        // Sequential, stopping at the first: the answer is the same whichever.
        // eslint-disable-next-line no-await-in-loop
        const refusal = await refuseUnreachedRecord(tx, context, id);
        if (refusal !== undefined) return refusal;
      }
    }
    asked.push(...fresh.map(({ id }) => id));
  }
  if (asked.length === 0) return undefined;

  await tx.query(
    `update records
        set data = case when $3::text is null then data - 'board'
                        else jsonb_set(data, '{board}', to_jsonb($3::text)) end
      where business_id = $1 and id = any($2::uuid[])
        and (data ->> 'board') is distinct from $3::text`,
    [tx.businessId, asked, board],
  );
  return undefined;
}

/**
 * Whether two spellings of a board name the task's own board. A uuid names one
 * record in either case, and a row written before the board was lower-cased on
 * the way in can hold it in upper case, so both sides are folded.
 * `task.move` and `task.reparent` ask it alike, and on a yes each keeps the
 * stored spelling, so the task and its subtree still spell the board alike.
 */
function isSameBoard(stored: string | null, next: string | null): boolean {
  return (stored?.toLowerCase() ?? null) === (next?.toLowerCase() ?? null);
}

async function writeData(
  tx: TenantQuery,
  context: CommandContext,
  data: Readonly<Record<string, unknown>>,
  detail: Readonly<Record<string, unknown>>,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('writeData: the envelope read no target');
  const rows = await tx.query<{ readonly revision: string }>(
    `update records set data = $3 where business_id = $1 and id = $2 and deleted_at is null
     returning revision::text as revision`,
    [tx.businessId, target.id, data],
  );
  const written = rows[0];
  if (written === undefined) {
    return refused(refuseCommand('NOT_FOUND', [], ['No live task carries that identifier here.']));
  }
  return applied(target.id, Number(written.revision), detail);
}

/**
 * Move a task under another parent, or out to the top level.
 *
 * The placement is re-derived by the same function `task.create` uses, so a
 * reparented subtask inherits its new parent's board, loses its board section
 * and ranks after its new siblings — the three answers a subtask's placement
 * has, computed once and used twice rather than written down twice. Its
 * subtree follows it onto that board.
 *
 * Changing the parent can change the board, which is the access change
 * `task.move` guards, so the same two questions are asked here: `write` on the
 * new parent's record, before the parent is looked up or walked, and `write`
 * on the board it brings when that differs from the task's own. A caller who
 * may write the task but not the destination is refused, and learns nothing
 * about whether the parent exists.
 */
export async function reparentTask(
  tx: TenantQuery,
  context: CommandContext,
  sentParentId: string | null,
): Promise<HandlerOutcome> {
  // A uuid names one task in either case. Lower-cased once, as `rankTask`
  // does, so the comparisons below and the stored `parent` agree with the
  // uuid-typed slot and the sibling lock (docs/local/API.md, identifiers).
  const parentId = typeof sentParentId === 'string' ? sentParentId.toLowerCase() : sentParentId;
  const target = context.target;
  if (target === undefined) throw new Error('reparentTask: the envelope read no target');
  // First: an absent `parentId` would otherwise read as the top level below.
  const operands = refuseReparentOperands(parentId);
  if (operands !== undefined) return refused(operands);
  if (parentId === target.id) {
    return refused(
      refuseCommand('PLACEMENT_IS_DERIVED', ['parent'], ['A task cannot be its own parent.']),
    );
  }
  if (parentId !== null) {
    const unreached = await refuseUnreachedRecord(tx, context, parentId);
    if (unreached !== undefined) return refused(unreached);
  }
  // A grilling or prototype ticket leaves its map only by the map's owner (WF-1).
  const owned = await refuseOwnerTicketMove(tx, context, target.id, parentId);
  if (owned !== undefined) return refused(owned);
  // A subtask carries its parent's client (MP-4-4): moving a task under
  // another client's work is a client change, which is `task.set_party`'s.
  if (
    parentId !== null &&
    (await lockedClientOf(tx, context.spine.taskTypeId, parentId)) !==
      ((target.data['client'] as string | undefined)?.toLowerCase() ?? null)
  ) {
    return refused(refuseOtherClient());
  }
  if (
    parentId !== null &&
    (await wouldCloseParentLoop(tx, context.spine.taskTypeId, target.id, parentId))
  ) {
    return refused(
      refuseCommand(
        'PLACEMENT_IS_DERIVED',
        ['parent'],
        ['A task cannot be put under one of its own subtasks, at any depth.'],
      ),
    );
  }

  const currentBoard = (target.data['board'] as string | undefined) ?? null;
  const placement = await planTaskPlacement(tx, context.spine.taskTypeId, {
    parentId,
    board: parentId === null ? currentBoard : null,
    boardSection: null,
    boardIsTheTasksOwn: true,
  });
  if (isRecordsRefusal(placement)) return refused(placement);

  // The board is asked about, and the subtree carried, only when it changes.
  const sameBoard = isSameBoard(currentBoard, placement.board);
  if (!sameBoard) {
    if (placement.board !== null) {
      const unreached = await refuseUnreachedRecord(tx, context, placement.board);
      if (unreached !== undefined) return refused(unreached);
    }
    const carried = await carryBoardToDescendants(tx, context, target.id, placement.board);
    if (carried !== undefined) return refused(carried);
  }

  const board = sameBoard ? currentBoard : placement.board;
  const data = mergeFieldValues(target.data, {
    parent: parentId,
    board,
    board_section: null,
    board_rank: placement.boardRank,
  });
  return await writeData(tx, context, data, {
    parent: parentId,
    board,
    board_rank: placement.boardRank,
  });
}

/**
 * Move a task to another board, which is the access change `board`'s
 * `escalating_operation` names.
 *
 * The authority check the envelope already ran was for the record. Reaching
 * the destination board is a second question, and it is asked here rather than
 * assumed: a caller who may write this task but not that board is refused. It
 * is the envelope's question, `write` on `task`, put to the board's own record,
 * so a business grant covers every board and a record grant covers the one it
 * names. It is asked before the board is looked up, so a caller refused it
 * gets one answer for an unreached board, a foreign one and a fabricated one.
 * Moving a task off every board (`board: null`) reaches no container and asks
 * nothing further.
 *
 * Only a top-level task is moved. A subtask's board is its parent's, so it is
 * refused like its section, and the task's subtree follows it to the new board.
 */
export async function moveTask(
  tx: TenantQuery,
  context: CommandContext,
  sentBoard: string | null,
  boardSection: string | null,
): Promise<HandlerOutcome> {
  // Lower-cased once, so the task's own board in upper case is the same board
  // below: no re-rank, no carry and no second sibling-lock key.
  const board = typeof sentBoard === 'string' ? sentBoard.toLowerCase() : sentBoard;
  const target = context.target;
  if (target === undefined) throw new Error('moveTask: the envelope read no target');
  // The stored side too, and its spelling kept on a section change.
  const storedBoard = (target.data['board'] as string | undefined) ?? null;
  const sameBoard = isSameBoard(storedBoard, board);
  const isSubtask = (target.data['parent'] ?? null) !== null;
  if (isSubtask && boardSection !== null) {
    return refused(
      refuseCommand(
        'PLACEMENT_IS_DERIVED',
        ['board_section'],
        ['A subtask sits under its parent, not in a board section.'],
      ),
    );
  }
  if (isSubtask) {
    return refused(
      refuseCommand(
        'PLACEMENT_IS_DERIVED',
        ['board'],
        ['A subtask is on its parent’s board. Move the top-level task, or reparent this one.'],
      ),
    );
  }
  const definitions = await readFieldDefinitions(tx, context.spine.taskTypeId);
  const mistyped = refuseWrongValueType(definitions, { board, board_section: boardSection });
  if (mistyped !== undefined) return refused(mistyped);

  if (board !== null) {
    const unreached = await refuseUnreachedRecord(tx, context, board);
    if (unreached !== undefined) return refused(unreached);

    const found = await tx.query<{ readonly id: string }>(
      `select id from records
        where business_id = $1 and record_type_id = $2 and id = $3 and deleted_at is null`,
      [tx.businessId, context.spine.taskTypeId, board],
    );
    if (found.length === 0) {
      return refused(
        refuseCommand('NOT_FOUND', ['board'], ['No board carries that identifier here.']),
      );
    }
  }

  // Onto another board, the task ranks after that board's last task, as a new
  // one would: the rank it had was among the old board's tasks and can equal
  // one already here. A section change within the board keeps it.
  let boardRank: number | undefined;
  if (!sameBoard) {
    const carried = await carryBoardToDescendants(tx, context, target.id, board);
    if (carried !== undefined) return refused(carried);
    boardRank = await rankAfterSiblings(tx, context.spine.taskTypeId, null, board);
  }

  const placed = boardRank === undefined ? {} : { board_rank: boardRank };
  const moved = { board: sameBoard ? storedBoard : board, board_section: boardSection, ...placed };
  const data = mergeFieldValues(target.data, moved);
  return await writeData(tx, context, data, moved);
}

const NEIGHBOUR_NOT_ADJACENT = [
  'Another task now sits between those neighbours. Read the list again and send the two either side of where the task should go.',
];

/**
 * Place a task between two neighbours.
 *
 * The new rank is the midpoint of the two, or of the one given and the next
 * rank past it, or a gap beyond the one given when nothing is past it. A
 * caller cannot send a number: two clients reordering concurrently would
 * compute the same one, and the loser's move would land on top of the
 * winner's rather than beside it.
 *
 * So the neighbours are checked, not trusted. Each is asked the envelope's
 * question at its own record, before it is read, so an unreached, a foreign
 * and a fabricated neighbour get one answer. Each must be a live sibling of
 * the task (the same parent, or the same board at the top level), `afterId`
 * must rank below `beforeId`, and no live sibling may sit between them: under
 * the sibling-set lock, the second of two clients sending the same pair sees
 * the first one's task there and is refused rather than tied with it. A rank
 * that would equal a neighbour's (the gap is spent) is refused, never written.
 * Trashed siblings keep their ranks, so the midpoint is taken to the nearest
 * rank, live or trashed, and a restore cannot bring back a tie.
 */
export async function rankTask(
  tx: TenantQuery,
  context: CommandContext,
  sentAfterId: string | null,
  sentBeforeId: string | null,
): Promise<HandlerOutcome> {
  // A uuid names one task in either case. Lower-cased once here, so the
  // comparisons below (with the target, with each other, with the rows read)
  // agree with Postgres, which reads both forms as the same id.
  const afterId = sentAfterId?.toLowerCase() ?? null;
  const beforeId = sentBeforeId?.toLowerCase() ?? null;
  const target = context.target;
  if (target === undefined) throw new Error('rankTask: the envelope read no target');
  if (afterId === null && beforeId === null) {
    return refused(
      refuseCommand(
        'PLACEMENT_IS_DERIVED',
        ['board_rank'],
        [
          'Ranking takes neighbours: send afterId, beforeId, or both.',
          'An absolute rank is the server’s, so two clients reordering cannot collide.',
        ],
      ),
    );
  }
  if (
    afterId === target.id ||
    beforeId === target.id ||
    (afterId !== null && afterId === beforeId)
  ) {
    return refused(
      refuseCommand(
        'PLACEMENT_IS_DERIVED',
        ['neighbour'],
        ['A task is ranked between two other tasks, not beside itself or one task twice.'],
      ),
    );
  }
  const parent = (target.data['parent'] as string | undefined) ?? null;
  const given = [afterId, beforeId].filter((id) => id !== null);
  // Unreached at its own scope, the target was admitted by its map's grant (W12).
  let viaMap = await refuseUnreachedRecord(tx, context, target.id);
  for (const id of given) {
    // eslint-disable-next-line no-await-in-loop
    const unreached = await refuseUnreachedRecord(tx, context, id);
    if (unreached === undefined) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await reachedThroughMap(tx, context, id, parent))) return refused(unreached);
    viaMap ??= unreached;
  }

  const board = parent === null ? ((target.data['board'] as string | undefined) ?? null) : null;
  await lockSiblings(tx, parent, board);
  // A target or neighbour admitted by the map's grant: the parent is held and read again,
  // so a retype that committed meanwhile is refused and none commits before the rank.
  if (
    viaMap !== undefined &&
    parent !== null &&
    (await wayfinderFacts(tx, parent, true))?.type !== 'map'
  ) {
    return refused(viaMap);
  }

  const neighbours = await tx.query<{ readonly id: string; readonly rank: string | null }>(
    `select id, ${BOARD_RANK}::text as rank from records
      where business_id = $1 and record_type_id = $2 and id = any($3::uuid[])
        and deleted_at is null
        and (case when $4::uuid is null
                  then ${PARENT} is null and ${BOARD} is not distinct from $5::uuid
                  else ${PARENT} = $4::uuid end)`,
    [tx.businessId, context.spine.taskTypeId, given, parent, board],
  );
  const rankOf = (id: string | null): number | undefined => {
    if (id === null) return undefined;
    const found = neighbours.find((row) => row.id === id);
    return found?.rank === null || found?.rank === undefined ? undefined : Number(found.rank);
  };
  const after = rankOf(afterId);
  const before = rankOf(beforeId);
  if ((afterId !== null && after === undefined) || (beforeId !== null && before === undefined)) {
    return refused(
      refuseCommand(
        'NOT_FOUND',
        ['neighbour'],
        ['A neighbour is not there, carries no rank, or is not a sibling of this task.'],
      ),
    );
  }
  if (after !== undefined && before !== undefined && after >= before) {
    return refused(
      refuseCommand(
        'PLACEMENT_IS_DERIVED',
        ['neighbour'],
        ['afterId must rank before beforeId. Read the list again and send them in its order.'],
      ),
    );
  }

  const inside = await siblingRanks(
    tx,
    context.spine.taskTypeId,
    { parentId: parent, board },
    { above: after ?? null, below: before ?? null },
    target.id,
  );
  const low = after ?? -Infinity;
  const high = before ?? Infinity;
  if (after !== undefined && before !== undefined && inside.some((sibling) => sibling.live)) {
    return refused(refuseCommand('PLACEMENT_IS_DERIVED', ['neighbour'], NEIGHBOUR_NOT_ADJACENT));
  }
  // The nearest rank past the neighbour given, live or trashed. With one
  // neighbour this is "directly after it" (or before); with two it is `before`
  // itself unless a trashed sibling holds a rank between them.
  const nextAbove = inside.reduce((least, sibling) => Math.min(least, sibling.rank), high);
  const nextBelow = inside.reduce((most, sibling) => Math.max(most, sibling.rank), low);
  const floor = after ?? nextBelow;
  const ceiling = after === undefined ? high : nextAbove;
  const rank =
    Number.isFinite(floor) && Number.isFinite(ceiling)
      ? (floor + ceiling) / 2
      : Number.isFinite(floor)
        ? floor + RANK_GAP
        : ceiling - RANK_GAP;
  if (rank <= floor || rank >= ceiling) {
    return refused(
      refuseCommand(
        'PLACEMENT_IS_DERIVED',
        ['neighbour'],
        [
          'There is no rank left between those neighbours.',
          'Place the task after another neighbour, or move one of these first.',
        ],
      ),
    );
  }

  const data = mergeFieldValues(target.data, { board_rank: rank });
  return await writeData(tx, context, data, { board_rank: rank });
}
