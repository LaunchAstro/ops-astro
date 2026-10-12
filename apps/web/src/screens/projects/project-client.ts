// SPDX-License-Identifier: AGPL-3.0-only
//
// A selected project's own client, for the board's New task doors: a client's
// project takes only that client's work, and the address the app writes for a
// project (`?board=<id>`) names no client. Read once per project; a refused or
// failed read, or a project with no client the reader can name, gives none.

import { useEffect, useState } from 'react';
import type { ClientView, TaskReadResult } from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { addressScope } from './board-address.ts';

export function useProjectClient(
  client: OperationsClient,
  grantKey: string,
  query: string,
): ClientView | null {
  const scope = addressScope(query);
  // A board scoped to a client already names it.
  const boardId = scope?.kind === 'selected' && scope.client === undefined ? scope.boardId : null;
  const of = `${grantKey}:${boardId ?? ''}`;
  const [held, setHeld] = useState<{ readonly of: string; readonly client: ClientView } | null>(
    null,
  );
  useEffect(() => {
    if (boardId === null) return;
    let live = true;
    void client.read<TaskReadResult>('task.read', { recordId: boardId }).then((read) => {
      const task = 'value' in read && 'task' in read.value ? read.value.task : null;
      const summary = task?.clientSummary;
      if (live && typeof task?.client === 'string' && summary?.kind === 'readable')
        setHeld({ of, client: { clientId: task.client, name: summary.name } });
      return read;
    });
    return () => {
      live = false;
    };
  }, [client, of]);
  return held?.of === of ? held.client : null;
}
