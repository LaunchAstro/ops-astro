// SPDX-License-Identifier: AGPL-3.0-only
//
// Which read a name becomes, and everything that has to be true before it runs.
//
// The order is the commands' order, for the commands' reason. Authority first,
// so a caller with no grant learns nothing about whether the record exists; the
// read after it, so "denied" and "not there" are answered by different code
// paths and cannot be confused for each other.
//
// The switch is here rather than inline in `execute.ts` because
// `surfaces/exported.ts` reads the operation surface out of the dispatch files
// rather than out of the declaration table -- a read declared with nothing to
// serve it would otherwise pass parity.

import type { TenantQuery } from '../tenancy/database.ts';
import type { Session } from '../identity/login-resolution.ts';
import { checkAuthority, subjectsOf, type Action } from '../authority/grants.ts';
import { fromAuthority, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { readTaskSpine } from '../commands/context.ts';
import type { ReadRequest, ReadResult } from './requests.ts';
import { readBoard, readTaskDetail, resolveTaskId } from './tasks.ts';
import { listPeople } from './people.ts';

/** The collection each read asks the grant model about. */
function collectionOf(request: ReadRequest): string {
  switch (request.read) {
    case 'task.read':
    case 'task.board':
      return 'task';
    case 'person.list':
      return 'person';
  }
}

const READ: Action = 'read';

export async function runRead(
  tx: TenantQuery,
  session: Session,
  request: ReadRequest,
): Promise<ReadResult | CommandRefusal> {
  // `task.read` names one record and may name it by key, so the identifier is
  // resolved before the grant check and never after it: a record-scoped grant
  // is a grant on a record, not on whichever spelling the caller used. The
  // lookup answers nobody -- a caller with no grant is refused below and
  // learns nothing from it either way -- and an unresolved name is checked at
  // business scope, so "there is no such task" is still answered by the read
  // and never by the authority check.
  const spine = request.read === 'person.list' ? undefined : await readTaskSpine(tx);
  const recordId =
    request.read === 'task.read' && spine !== undefined
      ? await resolveTaskId(tx, spine.taskTypeId, request.recordId)
      : undefined;

  const authorised = await checkAuthority(tx, subjectsOf(session), {
    collection: collectionOf(request),
    action: READ,
    // A record-scoped grant is checked against the record named, exactly as a
    // targeted command's is. A business-scoped grant covers both, which is
    // what `effectiveGrants` already means by `scope_kind = 'business'`.
    scope:
      recordId === undefined ? { kind: 'business', id: null } : { kind: 'record', id: recordId },
  });
  if (!authorised.ok) return fromAuthority(authorised.refusal);

  switch (request.read) {
    case 'task.read': {
      const task =
        recordId === undefined || spine === undefined
          ? undefined
          : await readTaskDetail(tx, spine.taskTypeId, recordId);
      // Not there, or there in another business: one answer, deliberately.
      return task === undefined ? refuseNotFound() : { ok: true, task };
    }
    case 'task.board': {
      if (spine === undefined) throw new Error('runRead: task.board reached without the spine');
      return { ok: true, tasks: await readBoard(tx, spine.taskTypeId, request.board) };
    }
    case 'person.list':
      return { ok: true, persons: await listPeople(tx) };
  }
}
