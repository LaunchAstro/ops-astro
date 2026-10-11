// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import { boardDoor } from './ProjectsToolbar.tsx';
import type { BoardAddress } from './scoped-board.ts';

/** The authorised board's empty state; loading and refused reads never draw it. */
export function NoTasks(props: {
  readonly scope: BoardAddress;
  readonly canFileTask: boolean;
}): ReactElement {
  return (
    <Empty
      title="No tasks on this board yet."
      description="You are permitted to see it and it has nothing in it."
      hint="Start one in the new task draft."
      action={
        props.canFileTask ? (
          <button
            className="btn btn--secondary btn--sm"
            type="button"
            data-projects-empty-new-task
            {...boardDoor(props.scope, true)}
          >
            New task
          </button>
        ) : undefined
      }
    />
  );
}
