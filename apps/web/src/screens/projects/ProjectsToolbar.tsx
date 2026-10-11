// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Icon, usePageToolbar } from '@launchastro/ui';
import { TASK_STAGES, type ClientView } from '../../../../../packages/core-wire/src/index.ts';
import { addressScope, queryOf } from './board-address.ts';

/**
 * A New task door on the board at `address`, filed with its context: the
 * board's client (its scope's, else the one Client filter's, named from
 * `clients`) and project, the one stage it is filtered to, and the one
 * priority and category its scope reads as. Two of a kind guess neither.
 */
export function boardDoor(
  address: string | undefined,
  canFileTask: boolean,
  clients: readonly ClientView[] = [],
): Readonly<Record<string, string | undefined>> {
  if (!canFileTask) return {};
  const scope = addressScope(address);
  const chips = scope?.filters ?? [];
  const priority = only(chips.flatMap((chip) => (chip.kind === 'priority' ? [chip.value] : [])));
  const facets = (new URLSearchParams(queryOf(address)).get('f') ?? '').split(',');
  const filtered = only(facets.flatMap((facet) => valueOf('client', facet)));
  const clientId =
    scope?.client ??
    only([...new Set(clients.filter((one) => one.name === filtered).map((one) => one.clientId))]);
  return {
    'data-new-task': '',
    'data-new-task-label': 'Projects',
    'data-new-task-client': clientId,
    'data-new-task-client-name': clients.find((one) => one.clientId === clientId)?.name,
    'data-new-task-board': scope?.kind === 'selected' ? scope.boardId : undefined,
    'data-new-task-stage': only(
      facets.flatMap((facet) => valueOf('stage', facet).flatMap((label) => stageOf(label))),
    ),
    'data-new-task-priority': priority === undefined ? undefined : String(priority),
    'data-new-task-category': only(
      chips.flatMap((chip) => (chip.kind === 'category' ? [chip.value] : [])),
    ),
  };
}

const only = <Value,>(values: readonly Value[]): Value | undefined =>
  values.length === 1 ? values[0] : undefined;

/** A filter's value from its facet id (`stage:"Enquiries"`), the id's escapes undone; none for another kind. */
function valueOf(kind: string, facet: string): readonly string[] {
  const head = `${kind}:"`;
  if (!facet.startsWith(head) || !facet.endsWith('"') || facet.length <= head.length) return [];
  const value = facet.slice(head.length, -1);
  return [value.replaceAll('%2C', ',').replaceAll('%25', '%')];
}

/** A Stage filter's stage id, from its label. */
function stageOf(label: string): readonly string[] {
  const stage = TASK_STAGES.list().find((one) => one.label === label);
  return stage === undefined ? [] : [stage.id];
}

/** The page's New task, in the page toolbar; inline when the board is in a panel. */
export function ProjectsToolbar(props: {
  readonly inPanel: boolean;
  readonly canFileTask: boolean;
  /** The board's address, whose client and project the door carries. */
  readonly address: string;
  /** The clients the board knows by name, for a Client filter's door. */
  readonly clients: readonly ClientView[];
}): ReactElement {
  const pageBar = usePageToolbar();
  const bar = props.inPanel ? null : pageBar;
  const control = (
    <button
      className="btn btn--secondary btn--sm"
      type="button"
      data-projects-new-task
      {...boardDoor(props.address, props.canFileTask, props.clients)}
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
