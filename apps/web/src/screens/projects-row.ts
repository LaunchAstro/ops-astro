// SPDX-License-Identifier: AGPL-3.0-only
//
// What a Projects board row does (MP-5-9, MP-5-10), as commands. The tick is
// the one completion transition, `task.complete` or `task.reopen`, never a
// second one; a rename is `task.update` on the title. The cell editors send
// `task.assign`, `task.update` on the due date and `task.set_stage`; the
// assignee editor offers the people `person.list` answers, and none while
// that read has not answered. Each is sent at the revision the
// board last read for that task, so a change made elsewhere since is refused
// as stale rather than overwritten, and every outcome re-reads the board. A
// plain click opens the task page until the dock panel lands (MP-4-8, U20).
// The hover box's timer starts the reader's own clock with `time.start`
// (MP-4-6, U19), the one clock the task page's time section also reads.

import type { RowActions } from '@launchastro/ui';
import type { BoardTask, PersonView } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';

export function rowActions(options: {
  readonly client: OperationsClient;
  readonly tasks: readonly BoardTask[];
  /** The people the assignee editor offers; null while unknown, and then no assignee editor. */
  readonly people: readonly PersonView[] | null;
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
    // No revision: a time entry is its own record, not a change to the task.
    onStartTimer: (row) => {
      send(client.mutate('time.start', { taskId: row.id }));
    },
    ...cellActions(client, options.people, at, send),
  };
}

/** The cell editors' commands (MP-5-10): assignee, due date and stage, each at the board's revision. */
function cellActions(
  client: OperationsClient,
  people: readonly PersonView[] | null,
  at: (id: string) => { readonly expectedRevision?: number },
  send: (sent: Promise<unknown>) => void,
): RowActions {
  return {
    ...(people === null
      ? {}
      : {
          people: people.map((person) => ({ id: person.personId, name: person.name })),
          onAssign: (row, assignee) => {
            send(
              client.mutate('task.assign', { recordId: row.id, fields: { assignee } }, at(row.id)),
            );
          },
        }),
    onDue: (row, due) => {
      send(client.mutate('task.update', { recordId: row.id, fields: { due } }, at(row.id)));
    },
    onStage: (row, stage) => {
      send(client.mutate('task.set_stage', { recordId: row.id, fields: { stage } }, at(row.id)));
    },
  };
}
