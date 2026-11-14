// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.bin` (#2346): the deleted tasks a person who can delete may restore.
//
// `task.delete` and `task.trash` stamp one batch across a task and its
// subtasks, and `task.restore` takes that batch back. This read lists each
// batch once, at its root: the deleted task whose parent is not in the same
// batch. A subtask deleted with its parent has no row of its own, because
// restoring it alone is not what the batch does.
//
// It asks `decide`, `task.delete`'s grant, inside the statement that reads
// the rows, as `gate.pending` does: a business-wide grant sees every delete, a
// record-scoped one only the deletes rooted at its own records. A caller
// holding no `decide` is refused rather than answered with an empty list. It
// is staff's alone: an outside party, whose view of a task is the shared one,
// is answered as for nothing at all, as the ledger answers them.

import { coveredScopes, slotOf, subjectsOf, TASK_SPINE } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type { TaskBinResult } from '../../../core-wire/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { isInternalReader } from './tasks.ts';
import { ACTOR_KIND_NAME } from './ledger.ts';
import type { ReadRow } from './read-row.ts';

/** The newest deletes a page shows; older ones are said to exist, not listed. */
export const BIN_PAGE = 100;

const PARENT = slotOf(TASK_SPINE, 'parent');
const KEY = slotOf(TASK_SPINE, 'key');
const TITLE = slotOf(TASK_SPINE, 'title');

interface BinSqlRow {
  readonly batch_id: string;
  readonly task_id: string;
  readonly key: string | null;
  readonly title: string | null;
  readonly deleted_at: Date;
  readonly actor_kind: string | null;
  readonly actor_name: string | null;
}

const BIN = `select r.trash_batch_id::text as batch_id, r.id::text as task_id,
            r.${KEY} as key, r.${TITLE} as title, r.deleted_at,
            a.kind as actor_kind, p.display_name as actor_name
       from public.records r
       left join public.actors a
         on a.business_id = r.business_id and a.id = r.deleted_by_actor_id
       left join public.people p
         on p.business_id = a.business_id and p.id = a.person_id
      where r.business_id = $1
        and r.record_type_id = $2
        and r.deleted_at is not null
        and r.trash_batch_id is not null
        and not exists (
              select 1 from public.records up
               where up.business_id = r.business_id
                 and up.id = r.${PARENT}
                 and up.trash_batch_id = r.trash_batch_id)
        and ($3::boolean or r.id = any($4::uuid[]))
      order by r.deleted_at desc, r.id
      limit $5`;

export async function readBin(
  tx: TenantQuery,
  session: Session,
  taskTypeId: string,
): Promise<TaskBinResult | CommandRefusal> {
  if (!isInternalReader(session.roleKey)) return refuseNotFound();
  const scopes = await coveredScopes(tx, subjectsOf(session), {
    collection: 'task',
    action: 'decide',
  });
  if (!scopes.business && scopes.records.length === 0) {
    return refuseCommand(
      'SCOPE_NOT_GRANTED',
      [],
      ['no live grant covers it', 'ask a holder who may delegate'],
    );
  }
  const rows = await tx.query<BinSqlRow>(BIN, [
    tx.businessId,
    taskTypeId,
    scopes.business,
    scopes.records,
    BIN_PAGE + 1,
  ]);
  return {
    ok: true,
    bin: rows.slice(0, BIN_PAGE).map((row) => ({
      batchId: row.batch_id,
      taskId: row.task_id,
      key: row.key ?? '',
      title: row.title ?? '',
      deletedAt: new Date(row.deleted_at).toISOString(),
      deletedBy: row.actor_name ?? ACTOR_KIND_NAME[row.actor_kind ?? ''] ?? 'Someone',
    })),
    more: rows.length > BIN_PAGE,
  };
}

export const BIN_READS: { readonly 'task.bin': ReadRow<'task.bin'> } = {
  // No subject record: the list is about the deletes the caller may restore.
  // The door asks for any grant; the rows are filtered by the caller's
  // `decide` inside the query, and a caller holding none is refused.
  'task.bin': {
    identifiers: [],
    parse: () => ({ ok: true, operands: {} }),
    spine: true,
    authority: 'holds-any-grant',
    outsiderNotFound: true,
    serve: async (tx, session, _operands, { spine }) =>
      await readBin(tx, session, spine.taskTypeId),
  },
};
