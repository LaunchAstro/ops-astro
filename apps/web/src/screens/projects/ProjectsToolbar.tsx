// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@launchastro/ui';

export function ProjectsToolbar(props: {
  readonly bar: HTMLElement | null;
  readonly onNewTask?: (() => void) | undefined;
}): ReactElement {
  const control = (
    <button
      className="btn btn--secondary btn--sm"
      type="button"
      data-projects-new-task
      disabled={props.onNewTask === undefined}
      title={
        props.onNewTask === undefined
          ? 'The shared task draft is unavailable here.'
          : 'Open the shared new task draft'
      }
      onClick={props.onNewTask}
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
