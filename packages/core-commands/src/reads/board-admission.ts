// SPDX-License-Identifier: AGPL-3.0-only
//
// How `task.board` admits its reader and reads the board, and whether an id
// names a live task: the catalogue's board helpers (`reads/catalogue.ts`),
// kept beside it so the catalogue stays under the line cap.

import { readableScope, isUuid, subjectsOf } from '../../../core-records/src/index.ts';
import type { TenantQuery, Session } from '../../../core-records/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import type { TaskSpine } from '../commands/context.ts';
import type { BoardTask, ClientView } from '../../../core-wire/src/index.ts';
import { readBoardStamped } from './tasks.ts';
import { decideReach } from './awaiting.ts';
import { withBoardClients } from '../commands/task-content.ts';

/** The grant check's own refusal, for a list read that decides in its `serve`. */
const refuseScope = (): CommandRefusal =>
  refuseCommand(
    'SCOPE_NOT_GRANTED',
    [],
    ['no live grant covers it', 'ask a holder who may delegate'],
  );

/**
 * Whether `task.board` admits the caller, from the one read of their grants:
 * it admits, and `serve` filters with the same scope, so no grant changes
 * between the decision and the answer. It comes before any lookup, so a
 * member holding nothing learns nothing about which boards exist, and it is
 * refused as the grant check refuses, never answered with an empty list
 * (`declared-within`). `admitRead` asks it too (catalogue #415).
 */
export async function boardAdmission(
  tx: TenantQuery,
  session: Session,
  board: string | null,
  spine: TaskSpine,
): Promise<
  | { readonly refusal: CommandRefusal }
  | { readonly scope: Awaited<ReturnType<typeof readableScope>> }
> {
  const scope = await readableScope(tx, subjectsOf(session), 'task', 'read');
  const unreadable = (one: string | null): boolean =>
    !scope.business && (one === null ? scope.records.length === 0 : !scope.records.includes(one));
  if (unreadable(null)) return { refusal: refuseScope() };
  // A board is a task record, so one that is not alpha's is refused the
  // way `task.move` refuses it, and never listed as a board with nothing
  // on it: minimum contract 8.2 case 1 asks `NOT_FOUND` for another
  // business's identifier and case 3 says a denied list is never an empty
  // success. Foreign, fabricated, malformed and trashed all get the one
  // answer. `null` is the list of tasks on no board and is not a lookup.
  if (typeof board === 'string' && !(await liveTask(tx, spine.taskTypeId, board))) {
    return { refusal: refuseNotFound() };
  }
  // A named board is itself a task: one the caller cannot read is refused
  // as `task.read` refuses it, in-tenant (I05).
  if (unreadable(board)) return { refusal: refuseScope() };
  return { scope };
}
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
): Promise<{
  readonly tasks: readonly (Omit<BoardTask, 'client'> & { readonly client: ClientView | null })[];
  readonly changedAt: string | null;
}> {
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
