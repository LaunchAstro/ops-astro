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

import type { TenantQuery } from '../tenancy/database.ts';
import { isRecordsRefusal } from '../records/refusals.ts';
import {
  RANK_GAP,
  mergeFieldValues,
  planTaskPlacement,
  wouldCloseParentLoop,
} from '../tasks/placement.ts';
import { readFieldDefinitions } from '../records/field-store.ts';
import { checkAuthority, subjectsOf } from '../authority/grants.ts';
import { fromReasoned, fromRecords, refuseCommand } from './refusal.ts';
import { refuseWrongValueType } from './values.ts';
import { refuseReparentOperands } from './operands.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import type { CommandContext } from './context.ts';

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
 * has, computed once and used twice rather than written down twice.
 */
export async function reparentTask(
  tx: TenantQuery,
  context: CommandContext,
  parentId: string | null,
): Promise<HandlerOutcome> {
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

  const placement = await planTaskPlacement(tx, context.spine.taskTypeId, {
    parentId,
    board: parentId === null ? ((target.data['board'] as string | undefined) ?? null) : null,
    boardSection: null,
  });
  if (isRecordsRefusal(placement)) return refused(fromRecords(placement));

  const data = mergeFieldValues(target.data, {
    parent: parentId,
    board: placement.board,
    board_section: null,
    board_rank: placement.boardRank,
  });
  return await writeData(tx, context, data, {
    parent: parentId,
    board: placement.board,
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
 */
export async function moveTask(
  tx: TenantQuery,
  context: CommandContext,
  board: string | null,
  boardSection: string | null,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('moveTask: the envelope read no target');
  if ((target.data['parent'] ?? null) !== null && boardSection !== null) {
    return refused(
      refuseCommand(
        'PLACEMENT_IS_DERIVED',
        ['board_section'],
        ['A subtask sits under its parent, not in a board section.'],
      ),
    );
  }
  const definitions = await readFieldDefinitions(tx, context.spine.taskTypeId);
  const mistyped = refuseWrongValueType(definitions, { board, board_section: boardSection });
  if (mistyped !== undefined) return refused(mistyped);

  if (board !== null) {
    const reached = await checkAuthority(tx, subjectsOf(context.session), {
      collection: 'task',
      action: 'write',
      scope: { kind: 'record', id: board },
    });
    if (!reached.ok) return refused(fromReasoned(reached.refusal));

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

  const data = mergeFieldValues(target.data, { board, board_section: boardSection });
  return await writeData(tx, context, data, { board, board_section: boardSection });
}

/**
 * Place a task between two neighbours.
 *
 * The new rank is the midpoint of the two, or a gap beyond the single one
 * given. A caller cannot send a number: two clients reordering concurrently
 * would compute the same one, and the loser's move would land on top of the
 * winner's rather than beside it.
 */
export async function rankTask(
  tx: TenantQuery,
  context: CommandContext,
  afterId: string | null,
  beforeId: string | null,
): Promise<HandlerOutcome> {
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

  const neighbours = await tx.query<{ readonly id: string; readonly rank: string | null }>(
    `select id, num_2::text as rank from records
      where business_id = $1 and record_type_id = $2 and id = any($3::uuid[])
        and deleted_at is null`,
    [tx.businessId, context.spine.taskTypeId, [afterId, beforeId].filter((id) => id !== null)],
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
      refuseCommand('NOT_FOUND', ['neighbour'], ['A neighbour is not there, or carries no rank.']),
    );
  }

  const rank =
    after !== undefined && before !== undefined
      ? (after + before) / 2
      : after !== undefined
        ? after + RANK_GAP
        : (before ?? 0) - RANK_GAP;

  const data = mergeFieldValues(target.data, { board_rank: rank });
  return await writeData(tx, context, data, { board_rank: rank });
}
