// SPDX-License-Identifier: AGPL-3.0-only
//
// The board a task sits on, as its page's crumb reads it (MP-4-1, CS-4.38).
//
// A board is a task: the `board` slot names one. So its title is a task title,
// and it is sent only to a reader who may read that board, by the single-record
// check `task.read` makes for the board itself. Anyone else is told there is a
// board and nothing about it, which is what the task's own record already says.
//
// **Asked before it is looked up.** The check runs on the id the slot holds,
// before the board row is read, so a reader refused it learns nothing of
// whether the board is live, trashed or foreign. The lookup that follows is
// filtered by this business, so a slot that names another business's record
// reads as no board, whoever asks.
//
// **Read at read, never copied.** The title comes from the board's own row on
// every read, so a renamed board is the next read's crumb.

import { checkAuthority, isUuid } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { BoardCrumb } from '../../../core-wire/src/index.ts';
import type { RankPool } from './rank.ts';

/**
 * The crumb's board for a task whose `board` slot holds `boardId`. The pool is
 * the one the rank reads under: a person's grants, or an agent's one task,
 * which never reaches a board, so an agent is told only that there is one.
 */
export async function readBoardCrumb(
  tx: TenantQuery,
  taskTypeId: string,
  boardId: string | null,
  pool: RankPool,
): Promise<BoardCrumb | null> {
  if (boardId === null || !isUuid(boardId)) return null;
  if (pool.kind === 'task') return { readable: false };
  const reached = await checkAuthority(tx, pool.subjects, {
    collection: 'task',
    action: 'read',
    scope: { kind: 'record', id: boardId },
  });
  if (!reached.ok) return { readable: false };
  const rows = await tx.query<{ readonly title: string | null }>(
    `select r.txt_4 as title from public.records r
      where r.business_id = $1 and r.record_type_id = $2 and r.id = $3
        and r.deleted_at is null`,
    [tx.businessId, taskTypeId, boardId],
  );
  const board = rows[0];
  return board === undefined ? null : { readable: true, title: board.title };
}
