// SPDX-License-Identifier: AGPL-3.0-only
//
// What a Projects board row does (MP-5-9, MP-5-10), as commands. The tick is
// the one completion transition, `task.complete` or `task.reopen`, never a
// second one; a rename is `task.update` on the title. The cell editors send
// `task.assign`, `task.update` on the due date and on the estimate (MP-4-8,
// offering the task panel's choices) and `task.set_stage`; the
// assignee editor offers the people `person.list` answers, and none while
// that read has not answered. Each is sent at the revision the
// board last read for that task, so a change made elsewhere since is refused
// as stale rather than overwritten, and every outcome re-reads the board. A
// plain click opens the task beside the board in the dock task panel
// (MP-4-8), or its page where the screen has no panel.
// The hover box's timer starts the reader's own clock with `time.start`
// (MP-4-6, U19), the one clock the task page's time section also reads.

import type { RowActions } from '@launchastro/ui';
import type { BoardTask, PersonView } from '../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../operations/client.ts';
import { ESTIMATE_CHOICES } from './task/estimates.ts';
import { TASK_STAGES } from '../../../../packages/core-wire/src/index.ts';

/**
 * What the board needs of the dock task panel's host (the application's
 * `TaskPanelHost`, MP-4-8): open a task by a door, and the count of changes
 * made in it. Declared here so the board does not import the registry that
 * imports it.
 */
export interface BoardPanelHost {
  readonly open: (taskKey: string, door: 'open' | 'reply', tab?: 'all') => void;
  readonly changes: number;
}
/** The row open beside the board, and the door it was opened by. */
export interface RowOpened {
  readonly id: string;
  readonly door: 'open' | 'reply';
}

export function rowActions(options: {
  readonly client: OperationsClient;
  readonly tasks: readonly BoardTask[];
  /** The people the assignee editor offers; null while unknown, and then no assignee editor. */
  readonly people: readonly PersonView[] | null;
  readonly href: (key: string) => string;
  readonly reload: () => void;
  /** The dock task panel, which rows open beside the board (MP-5-8, CS-5.14). */
  readonly panel?: {
    readonly host: BoardPanelHost;
    readonly opened: RowOpened | null;
    readonly setOpened: (opened: RowOpened) => void;
  };
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
    ...openers(options),
    // No revision: a time entry is its own record, not a change to the task.
    onStartTimer: (row) => {
      send(client.mutate('time.start', { taskId: row.id }));
    },
    ...cellActions(client, options.people, at, send),
  };
}

/** The cell editors' commands (MP-5-10): assignee, due date, stage and estimate, each at the board's revision. */
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
      // The board draws labels; the task stores the stage's id.
      send(
        client.mutate(
          'task.set_stage',
          { recordId: row.id, fields: { stage: TASK_STAGES.idOf(stage) } },
          at(row.id),
        ),
      );
    },
    estimates: ESTIMATE_CHOICES,
    onEstimate: (row, minutes) => {
      send(
        client.mutate(
          'task.update',
          { recordId: row.id, fields: { estimated_minutes: minutes } },
          at(row.id),
        ),
      );
    },
  };
}

/**
 * Opening a row: beside the board in the dock task panel when the page has
 * one, the name to the task and the comment badge to its conversation on
 * All, which holds both a client's messages and the mentions the badge
 * counts (P-36); without a panel the name opens the task page.
 */
function openers(options: {
  readonly href: (key: string) => string;
  readonly panel?: {
    readonly host: BoardPanelHost;
    readonly opened: RowOpened | null;
    readonly setOpened: (opened: RowOpened) => void;
  };
}): RowActions {
  const panel = options.panel;
  if (panel === undefined) {
    return {
      onOpen: (row) => {
        window.location.assign(options.href(row.key));
      },
    };
  }
  return {
    onOpen: (row) => {
      panel.setOpened({ id: row.id, door: 'open' });
      panel.host.open(row.key, 'open');
    },
    onOpenComments: (row) => {
      panel.setOpened({ id: row.id, door: 'reply' });
      panel.host.open(row.key, 'reply', 'all');
    },
    ...(panel.opened === null ? {} : { opened: panel.opened }),
  };
}
