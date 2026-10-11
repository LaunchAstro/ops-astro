// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Icon, usePageToolbar } from '@launchastro/ui';
import { TASK_STAGES } from '../../../../../packages/core-wire/src/index.ts';
import { addressScope, queryOf } from './board-address.ts';

/**
 * A New task door on the board at `address`, filed with its context: the
 * board's client and project, the one stage it is filtered to, and the one
 * priority and category its scope reads as. Two of a kind guess neither.
 */
export function boardDoor(
  address: string | undefined,
  canFileTask: boolean,
): Readonly<Record<string, string | undefined>> {
  if (!canFileTask) return {};
  const scope = addressScope(address);
  const chips = scope?.filters ?? [];
  const priority = only(chips.flatMap((chip) => (chip.kind === 'priority' ? [chip.value] : [])));
  const facets = (new URLSearchParams(queryOf(address)).get('f') ?? '').split(',');
  return {
    'data-new-task': '',
    'data-new-task-label': 'Projects',
    'data-new-task-client': scope?.client,
    'data-new-task-board': scope?.kind === 'selected' ? scope.boardId : undefined,
    'data-new-task-stage': only(facets.flatMap((facet) => stageOf(facet))),
    'data-new-task-priority': priority === undefined ? undefined : String(priority),
    'data-new-task-category': only(
      chips.flatMap((chip) => (chip.kind === 'category' ? [chip.value] : [])),
    ),
  };
}

const only = <Value,>(values: readonly Value[]): Value | undefined =>
  values.length === 1 ? values[0] : undefined;

/** A Stage filter's stage id, from its facet id (`stage:"Enquiries"`). */
function stageOf(facet: string): readonly string[] {
  const label = /^stage:"(.*)"$/u.exec(facet)?.[1]?.replaceAll('%2C', ',').replaceAll('%25', '%');
  const stage = TASK_STAGES.list().find((one) => one.label === label);
  return stage === undefined ? [] : [stage.id];
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
      {...boardDoor(props.address, props.canFileTask)}
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
