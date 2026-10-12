// SPDX-License-Identifier: AGPL-3.0-only
//
// A selected project's own client, for the board's New task doors: a client's
// project takes only that client's work, and the address the app writes for a
// project (`?board=<id>`) names no client. Read with the board's own reads, so
// a change to the project's client reaches the doors when it reaches the
// board, and given only while the board admits the reader. A board denial, or
// a reread that drops the board's answer after an admission (as a denial or an
// outage does, even one no render drew), withdraws it, and only a read begun
// once the board admits the reader again gives it back. While a reread is in
// flight it gives none, so a door clicked mid-refresh never files the client
// the project had before. A refused or failed read, or a project with no
// client the reader can name, gives none.

import { useState } from 'react';
import type { ClientView, TaskReadResult } from '../../../../../packages/core-wire/src/index.ts';
import { useBoardProjectionRead } from '../../data/board-live.ts';
import {
  isRefusal,
  isUnavailable,
  type CallResult,
  type OperationsClient,
} from '../../operations/client.ts';
import { addressScope } from './board-address.ts';

async function readProjectClient(
  client: OperationsClient,
  boardId: string | null,
): Promise<CallResult<ClientView | null>> {
  if (boardId === null) return { ok: true, value: null };
  const read = await client.read<TaskReadResult>('task.read', { recordId: boardId });
  if (isRefusal(read) || isUnavailable(read)) return read;
  const task = 'task' in read.value ? read.value.task : null;
  const summary = task?.clientSummary;
  return {
    ok: true,
    value:
      typeof task?.client === 'string' && summary?.kind === 'readable'
        ? { clientId: task.client, name: summary.name }
        : null,
  };
}

export function useProjectClient(
  client: OperationsClient,
  grantKey: string,
  query: string,
  board: { readonly admitted: boolean; readonly denied: boolean; readonly answered: boolean },
): ClientView | null {
  const scope = addressScope(query);
  // A board scoped to a client already names it.
  const boardId = scope?.kind === 'selected' && scope.client === undefined ? scope.boardId : null;
  // Each admission after a withdrawal is a new read, so no answer read across it is given.
  const [since, setSince] = useState({ admissions: 0, admitted: false, withdrawn: false });
  const withdraw = board.denied || (since.admitted && !board.answered);
  if (withdraw && !since.withdrawn) setSince({ ...since, withdrawn: true });
  else if (board.admitted && (since.withdrawn || !since.admitted))
    setSince({
      admissions: since.admissions + (since.withdrawn ? 1 : 0),
      admitted: true,
      withdrawn: false,
    });
  const { state, own } = useBoardProjectionRead<ClientView | null>(client, {
    grantKey,
    run: () => readProjectClient(client, boardId),
    deps: [client, boardId, since.admissions],
  });
  if (!board.admitted || since.withdrawn || !own) return null;
  return state.outcome === 'ready' ? state.value : null;
}
