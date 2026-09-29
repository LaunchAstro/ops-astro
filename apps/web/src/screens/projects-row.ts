// SPDX-License-Identifier: AGPL-3.0-only
//
// What a Projects board row does (MP-5-9), as commands. The tick is the one
// completion transition, `task.complete` or `task.reopen`, never a second one;
// a rename is `task.update` on the title. Each is sent at the revision the
// board last read for that task, so a change made elsewhere since is refused
// as stale rather than overwritten, and every outcome re-reads the board. A
// plain click opens the task page until the dock panel lands (MP-4-8, U20);
// the timer waits on the time commands (U19), so the row draws none.

import type { RowActions } from '@launchastro/ui';
import type { BoardTask } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';

export function rowActions(options: {
  readonly client: OperationsClient;
  readonly tasks: readonly BoardTask[];
  readonly href: (key: string) => string;
  readonly reload: () => void;
}): RowActions {
  const { client, reload } = options;
  const at = (id: string): { readonly expectedRevision?: number } => {
    const revision = options.tasks.find((task) => task.id === id)?.revision;
    return revision === undefined ? {} : { expectedRevision: revision };
  };
  // Settled or not, the board re-reads: a refusal redraws the stored truth.
  const send = (sent: Promise<unknown>): void => {
    void sent.then(reload, reload);
  };
  return {
    onTick: (row, done) => {
      send(
        done
          ? client.mutate('task.complete', { recordId: row.id }, at(row.id))
          : client.mutate(
              'task.reopen',
              { recordId: row.id, reason: 'Reopened from the Projects board' },
              at(row.id),
            ),
      );
    },
    onRename: (row, title) => {
      send(client.mutate('task.update', { recordId: row.id, fields: { title } }, at(row.id)));
    },
    onOpen: (row) => {
      window.location.assign(options.href(row.key));
    },
  };
}
