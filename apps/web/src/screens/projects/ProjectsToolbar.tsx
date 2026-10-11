// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Icon, usePageToolbar } from '@launchastro/ui';
import { addressScope } from './board-address.ts';
import type { BoardAddress } from './scoped-board.ts';

/** A New task door on this board, filed with the board's client and project. */
export function boardDoor(
  scope: BoardAddress | null,
  canFileTask: boolean,
): Readonly<Record<string, string | undefined>> {
  if (!canFileTask) return {};
  return {
    'data-new-task': '',
    'data-new-task-label': 'Projects',
    'data-new-task-client': scope?.client,
    'data-new-task-board': scope?.kind === 'selected' ? scope.boardId : undefined,
  };
}

/** The page's New task, in the page toolbar; inline when the board is in a panel. */
export function ProjectsToolbar(props: {
  readonly inPanel: boolean;
  readonly canFileTask: boolean;
  /** The board's address, whose client and project the door carries. */
  readonly address: string;
}): ReactElement {
  const pageBar = usePageToolbar();
  const bar = props.inPanel ? null : pageBar;
  const control = (
    <button
      className="btn btn--secondary btn--sm"
      type="button"
      data-projects-new-task
      {...boardDoor(addressScope(props.address), props.canFileTask)}
      disabled={!props.canFileTask}
      title={
        props.canFileTask
          ? 'Open the shared new task draft'
          : 'The shared task draft is unavailable here.'
      }
    >
      <Icon name="plus" size="xs" /> New task
    </button>
  );
  return bar === null ? (
    <div className="projects__toolbar">{control}</div>
  ) : (
    createPortal(control, bar)
  );
}
