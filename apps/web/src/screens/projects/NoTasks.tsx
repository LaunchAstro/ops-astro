// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type { ClientView } from '../../../../../packages/core-wire/src/index.ts';
import { boardDoor } from './ProjectsToolbar.tsx';

/** The authorised board's empty state; loading and refused reads never draw it. */
export function NoTasks(props: {
  /** The board's address, whose context the door carries. */
  readonly address: string;
  readonly canFileTask: boolean;
  /** The clients the board knows by name, for a Client filter's door. */
  readonly clients: readonly ClientView[];
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
            {...boardDoor(props.address, true, props.clients)}
          >
            New task
          </button>
        ) : undefined
      }
    />
  );
}
