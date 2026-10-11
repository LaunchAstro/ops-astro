// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects quick-add (U112): type a name and press Enter or the button,
// and the one kept new-task draft opens with that name and the board's scope.
// It is a door into the draft (`[data-new-task]`), never a second create form;
// the draft's Create writes the task.

import { useState, type ReactElement } from 'react';
import { Icon } from '@launchastro/ui';
import { boardDoor } from './ProjectsToolbar.tsx';
import type { BoardAddress } from './scoped-board.ts';

export function CreateTask(props: {
  readonly scope: BoardAddress;
  readonly canFileTask: boolean;
}): ReactElement {
  const [title, setTitle] = useState('');
  const named = title.trim();
  return (
    <form className="projects__create" onSubmit={(event) => event.preventDefault()}>
      <label className="visually-hidden" htmlFor="create-title">
        New task
      </label>
      <span className="cbd__field">
        <Icon name="plus" size="xs" />
        <input
          id="create-title"
          type="text"
          placeholder="Add a task…"
          disabled={!props.canFileTask}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </span>
      <button
        className="btn btn--secondary btn--sm"
        type="submit"
        disabled={!props.canFileTask || named === ''}
        {...boardDoor(props.scope, props.canFileTask && named !== '')}
        data-new-task-title={named === '' ? undefined : named}
      >
        Add to draft
      </button>
    </form>
  );
}
