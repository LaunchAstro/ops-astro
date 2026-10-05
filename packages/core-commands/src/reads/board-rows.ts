// SPDX-License-Identifier: AGPL-3.0-only
//
// The task board's rows, as `task.board` (`catalogue.ts`) serves them, a page
// of them, and the live-task check the catalogue's reads share.

import { isUuid, subjectsOf } from '../../../core-records/src/index.ts';
import type { readableScope, Session, TenantQuery } from '../../../core-records/src/index.ts';
import type { BoardTask } from '../../../core-wire/src/index.ts';
import type { CommandRefusal } from '../commands/refusal.ts';
import { withBoardClients } from '../commands/task-content.ts';
import { decideReach } from './awaiting.ts';
import { pageOf, type Paging } from './detail.ts';
import { readBoardStamped } from './tasks.ts';

/**
 * The board's rows in the caller's read scope and the newest change among them
 * (MP-5-7), each row with its client where the caller reaches it, as `task.read`
 * sends it (the Clients row door). The caller's decide reach marks the Review
 * mode's rows (MP-5-12); it only marks rows already served under the read scope.
 */
export async function boardOf(
  tx: TenantQuery,
  session: Session,
  taskTypeId: string,
  board: string | null,
  scope: Awaited<ReturnType<typeof readableScope>>,
): Promise<{ readonly tasks: readonly BoardTask[]; readonly changedAt: string | null }> {
  const { tasks, changedAt } = await readBoardStamped(
    tx,
    taskTypeId,
    board,
    scope.business ? null : scope.records,
    await decideReach(tx, session),
    session.personId,
  );
  return { tasks: await withBoardClients(tx, tasks, subjectsOf(session)), changedAt };
}

/** Whether `id` names a live task in the caller's business: `task.move`'s own check. */
export async function liveTask(tx: TenantQuery, taskTypeId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const found = await tx.query<{ readonly id: string }>(
    `select id from records
      where business_id = $1 and record_type_id = $2 and id = $3 and deleted_at is null`,
    [tx.businessId, taskTypeId, id],
  );
  return found.length > 0;
}

/**
 * One page of the board's rows (API-3) when the body asks for a level, a
 * size or a page; the same rows in the same order. Absent all three, none.
 */
export function boardPage(
  tasks: readonly BoardTask[],
  paging: Paging,
):
  | CommandRefusal
  | {
      readonly ok: true;
      readonly page: readonly Readonly<Record<string, unknown>>[];
      readonly next: string | null;
    }
  | undefined {
  if (Object.keys(paging).length === 0) return undefined;
  const page = pageOf(tasks, paging);
  return 'refused' in page ? page : { ok: true, page: page.items, next: page.next };
}
