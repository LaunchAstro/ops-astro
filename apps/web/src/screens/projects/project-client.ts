// SPDX-License-Identifier: AGPL-3.0-only
//
// A selected project's own client, for the board's New task doors: a client's
// project takes only that client's work, and the address the app writes for a
// project (`?board=<id>`) names no client. Read with the board's own reads, so
// a change to the project's client reaches the doors when it reaches the
// board, and given only while the board's reads are not refused (`onDenied`,
// which the board calls), so a denial withdraws the client even with this read
// still in flight. A refused
// or failed read, or a project with no client the reader can name, gives none.

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
): { readonly client: ClientView | null; readonly onDenied: (denied: boolean) => void } {
  const [denied, onDenied] = useState(false);
  const scope = addressScope(query);
  // A board scoped to a client already names it.
  const boardId = scope?.kind === 'selected' && scope.client === undefined ? scope.boardId : null;
  const { state, own } = useBoardProjectionRead<ClientView | null>(client, {
    grantKey,
    run: () => readProjectClient(client, boardId),
    deps: [client, boardId],
  });
  // A board denial withdraws the client with the rows, whatever this read answers later.
  return { client: !denied && own && state.outcome === 'ready' ? state.value : null, onDenied };
}
