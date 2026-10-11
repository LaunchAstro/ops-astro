// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects quick-add (U112): type a name and press Enter or the button,
// and the one kept new-task draft opens with that name and the board's scope.
// It is a door into the draft (`[data-new-task]`), never a second create form;
// the draft's Create writes the task.

import { useState, type ReactElement } from 'react';
import { Icon } from '@launchastro/ui';
import type { ClientView } from '../../../../../packages/core-wire/src/index.ts';
import { boardDoor } from './ProjectsToolbar.tsx';

export function CreateTask(props: {
  /** The board's address, whose context the door carries. */
  readonly address: string;
  readonly canFileTask: boolean;
  /** The clients the board knows by name, for a Client filter's door. */
  readonly clients: readonly ClientView[];
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
        {...boardDoor(props.address, props.canFileTask && named !== '', props.clients)}
        data-new-task-title={named === '' ? undefined : named}
      >
        Add to draft
      </button>
    </form>
  );
}
