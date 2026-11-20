// SPDX-License-Identifier: AGPL-3.0-only
//
// The people an internal comment on one task may name (#1245): the
// business's staff who can read it, the check `task.comment` makes before it
// accepts a mention (INB-1, `readMentions`), so the picker never offers a name
// the server refuses. Asked like `task.execution`, of a live task the caller
// reads, and it names only the people the caller could already see
// (`seenBy`, the line `person.list` and a refused mention hold), so a task
// reader refused the people directory is told nobody.

import { readMentions, seenBy, type TenantQuery } from '../../../core-records/src/index.ts';
import type { PersonListResult } from '../../../core-wire/src/index.ts';
import { invalid } from '../commands/operands.ts';
import { refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { liveTask } from './board-admission.ts';
import { listPeople } from './people.ts';
import type { ReadRow } from './read-row.ts';
import type { PersonView } from './requests.ts';
import { isInternalReader, resolveTaskId } from './tasks.ts';

/** The staff who can read this task's internal comments, of those the caller may see. */
export async function listMentionable(
  tx: TenantQuery,
  callerActorId: string,
  taskId: string,
): Promise<readonly PersonView[]> {
  const staff = await listPeople(tx);
  const seen = await seenBy(
    tx,
    callerActorId,
    staff.map((person) => person.personId),
  );
  const visible = staff.filter((person) => seen.has(person.personId));
  const named = await readMentions(
    tx,
    { taskId, audience: 'internal' },
    visible.map((person) => person.personId),
  );
  const readable = new Set(named.filter((person) => person.readable).map((one) => one.personId));
  return visible.filter((person) => readable.has(person.personId));
}

export const MENTIONABLE_READS: { readonly 'task.mentionable': ReadRow<'task.mentionable'> } = {
  'task.mentionable': {
    identifiers: ['recordId'],
    parse: ({ recordId }) =>
      typeof recordId === 'string'
        ? { ok: true, operands: { recordId } }
        : {
            ok: false,
            refusal: invalid('recordId', 'Send recordId as the task’s identifier or its key.'),
          },
    spine: true,
    subject: (tx, spine, operands) => resolveTaskId(tx, spine.taskTypeId, operands.recordId),
    authority: 'declared',
    outsiderNotFound: true,
    // Not there, in another business or trashed: one answer, as `task.read` gives.
    admits: async (tx, session, { spine, recordId }) =>
      recordId !== undefined &&
      isInternalReader(session.roleKey) &&
      (await liveTask(tx, spine.taskTypeId, recordId)),
    serve: async (
      tx,
      session,
      _operands,
      { recordId },
    ): Promise<PersonListResult | CommandRefusal> =>
      recordId === undefined
        ? refuseNotFound()
        : { ok: true, persons: await listMentionable(tx, session.actorId, recordId) },
  },
};
