// SPDX-License-Identifier: AGPL-3.0-only
//
// A selected project's own client, for the board's New task doors: a client's
// project takes only that client's work, and the address the app writes for a
// project (`?board=<id>`) names no client. Read with the board's own reads, so
// a change to the project's client reaches the doors when it reaches the
// board (a live change, or a task panel change unless a denial withdrew it,
// unsettling it from the commit that reports the change), and given only
// while the board admits the reader. A board denial,
// or a board with no answer past its opening read (as a denial or an outage
// leaves it, even one no render drew), withdraws it, and only a read begun
// once the board admits the reader again gives it back. While a reread is in
// flight it gives none, so a door clicked mid-refresh never files the client
// the project had before. A refused or failed read, or a project with no
// client the reader can name, gives none. Until the read has answered, the
// project's client is not settled, and a door names no client from any
// other source (a Client filter's), since the project's own may differ.

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

/** A board that is no selected project of its own has no project client to wait for. */
const NOT_SELECTED = { client: null, settled: true };
const UNSETTLED = { client: null, settled: false };

export function useProjectClient(
  client: OperationsClient,
  grantKey: string,
  query: string,
  board: {
    readonly admitted: boolean;
    readonly denied: boolean;
    /** Whether the board holds an answer, its last while a reread is out. */
    readonly answered: boolean;
    /** Whether the board's read is its opening one, which nothing has answered yet. */
    readonly opening: boolean;
    /** Every break the board's admission took, counted as each landed, drawn or not. */
    readonly breaks: number;
  },
  /** The task panel's count of changes, each a fresh read unless a denial withdrew the client. */
  changes: number,
): { readonly client: ClientView | null; readonly settled: boolean } {
  const scope = addressScope(query);
  // A board scoped to a client already names it.
  const boardId = scope?.kind === 'selected' && scope.client === undefined ? scope.boardId : null;
  // Each admission after a withdrawal, and each panel change outside one, is a fresh read
  // in the render that sees it, so no answer read across either is given.
  // A break counted since the last render withdraws too, though no render drew it.
  const [since, setSince] = useState({ reads: 0, withdrawn: false, changes, breaks: board.breaks });
  const withdraw = board.denied || (!board.answered && !board.opening);
  const owed = since.withdrawn || board.breaks !== since.breaks;
  const readmitted = !withdraw && board.admitted && owed;
  const changed = changes !== since.changes && !owed && !withdraw;
  const next = {
    reads: since.reads + (readmitted || changed ? 1 : 0),
    withdrawn: withdraw || (owed && !readmitted),
    changes,
    breaks: board.breaks,
  };
  if (
    next.reads !== since.reads ||
    next.withdrawn !== since.withdrawn ||
    changes !== since.changes ||
    next.breaks !== since.breaks
  )
    setSince(next);
  const { state, own } = useBoardProjectionRead<ClientView | null>(client, {
    grantKey,
    run: () => readProjectClient(client, boardId),
    deps: [client, boardId, since.reads],
  });
  if (boardId === null) return NOT_SELECTED;
  if (!board.admitted || since.withdrawn || !own || state.outcome !== 'ready') return UNSETTLED;
  return { client: state.value, settled: true };
}
