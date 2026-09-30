// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's Project select (MP-4-8, CS-4.15, DP-22).
//
// **A board is a project on the Projects board** (ORCH40). The choices are
// what `task.board` answers for the Projects board (`board: null`), so the
// list is the reader's own grants, filtered by the server; the task itself is
// never offered as its own board. None puts it back on the Projects board.
//
// **Marked by the crumb's id.** `task.read` names the board's id only to a
// reader who may open it; a board that is not a project stays among the
// choices as itself. A board the reader may not open is drawn as that and
// cannot be chosen, so the select says no more than the page's crumb does.
//
// **Through `task.move`** (`task:write`), at the revision the panel read; a
// move that lands is counted, a refusal is quoted in the server's words.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type {
  InternalTaskDetail as Task,
  TaskBoardResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { useRead } from '../../data/use-read.ts';
import { useCommand } from '../../records/use-command.ts';
import { RecordState } from '../../views/record-state.tsx';

const WITHHELD = 'withheld';

interface Choice {
  readonly id: string;
  readonly title: string | null;
}

/** The projects to offer: the Projects board's, less the task, plus its own board if not one. */
function choicesFor(task: Task, projects: readonly Choice[]): readonly Choice[] {
  const offered = projects.filter((project) => project.id !== task.id);
  const board = task.board;
  if (board === null || !board.readable || offered.some((project) => project.id === board.id)) {
    return offered;
  }
  return [...offered, { id: board.id, title: board.title }];
}

function valueOf(task: Task): string {
  if (task.board === null) return '';
  return task.board.readable ? task.board.id : WITHHELD;
}

function ProjectSelect(props: {
  readonly task: Task;
  readonly projects: readonly Choice[];
  readonly busy: boolean;
  readonly onMove: (board: string | null) => void;
}): ReactElement {
  const { task } = props;
  return (
    <select
      id="panel-field-board"
      className="input"
      disabled={props.busy}
      value={valueOf(task)}
      onChange={(event) => props.onMove(event.target.value === '' ? null : event.target.value)}
    >
      {task.board?.readable === false ? (
        <option value={WITHHELD} disabled>
          A board you cannot open
        </option>
      ) : null}
      <option value="">None</option>
      {choicesFor(task, props.projects).map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.title ?? 'Untitled'}
        </option>
      ))}
    </select>
  );
}

export function ProjectField(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly task: Task;
  readonly onChanged: () => void;
}): ReactElement {
  const { client, task } = props;
  const projects = useRead<TaskBoardResult>({
    grantKey: props.grantKey,
    run: () => client.read<TaskBoardResult>('task.board', { board: null }),
    deps: [],
  });
  const { busy, because, run } = useCommand();
  const move = (board: string | null): void => {
    run(
      () =>
        client.mutate(
          'task.move',
          { recordId: task.id, board },
          { expectedRevision: task.revision },
        ),
      (settlement) => {
        if (settlement.kind === 'ok') props.onChanged();
      },
    );
  };
  return (
    <>
      <label className="tf__k" htmlFor="panel-field-board">
        Project
      </label>
      <RecordState state={projects.state} subject="projects" onRetry={projects.reload}>
        {(value) => <ProjectSelect task={task} projects={value.tasks} busy={busy} onMove={move} />}
      </RecordState>
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </>
  );
}
