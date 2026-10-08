// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@launchastro/ui';

export function ProjectsToolbar(props: {
  readonly bar: HTMLElement | null;
  readonly canFileTask: boolean;
}): ReactElement {
  const control = (
    <button
      className="btn btn--secondary btn--sm"
      type="button"
      data-projects-new-task
      data-new-task={props.canFileTask ? '' : undefined}
      data-new-task-label={props.canFileTask ? 'Projects' : undefined}
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
  return props.bar === null ? (
    <div className="projects__toolbar">{control}</div>
  ) : (
    createPortal(control, props.bar)
  );
}
