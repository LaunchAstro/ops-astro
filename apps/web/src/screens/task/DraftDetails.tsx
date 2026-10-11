// SPDX-License-Identifier: AGPL-3.0-only
//
// The draft's project, stage, priority, description and agent brief (U112).
// Each change goes to `put` like every other draft field; Create writes them
// after the client, through `task.move`, `task.set_stage` and `task.update`.
//
// **The project list is read only when wanted.** A draft filed from a project
// reads it at once, to name that project; any other draft reads it when the
// Project select is first focused, so Create never waits on a task list.

import { useEffect, useState, type ReactElement } from 'react';
import { TASK_STAGES, type TaskBoardResult } from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import type { TaskDraft } from './task-draft.ts';

interface Props {
  readonly client: OperationsClient;
  readonly draft: TaskDraft;
  readonly put: (next: Partial<TaskDraft>) => void;
  readonly locked: boolean;
}

interface Choice {
  readonly id: string;
  readonly title: string;
}

const STAGES: readonly Choice[] = TASK_STAGES.list().map((stage) => ({
  id: stage.id,
  title: stage.label,
}));
const PRIORITIES: readonly Choice[] = [1, 2, 3, 4].map((value) => ({
  id: String(value),
  title: `P${String(value)}`,
}));

export function DraftDetails(props: Props): ReactElement {
  const { draft, put } = props;
  return (
    <>
      <DraftProject {...props} />
      <Select
        id="panel-draft-stage"
        label="Stage"
        locked={props.locked}
        value={draft.stage}
        choices={STAGES}
        onChoose={(stage) => {
          put({ stage });
        }}
      />
      <Select
        id="panel-draft-priority"
        label="Priority"
        locked={props.locked}
        value={draft.priority === null ? null : String(draft.priority)}
        choices={PRIORITIES}
        onChoose={(value) => {
          put({ priority: value === null ? null : Number(value) });
        }}
      />
      <Words id="panel-draft-description" label="Description" {...props} field="description" />
      <Words id="panel-draft-brief" label="Agent brief" {...props} field="agentBrief" />
    </>
  );
}

function Select(props: {
  readonly id: string;
  readonly label: string;
  readonly locked: boolean;
  readonly value: string | null;
  readonly choices: readonly Choice[];
  readonly none?: string;
  readonly onChoose: (value: string | null) => void;
  readonly onFocus?: () => void;
}): ReactElement {
  return (
    <div className="field">
      <label className="tf__k" htmlFor={props.id}>
        {props.label}
      </label>
      <select
        id={props.id}
        className="input"
        disabled={props.locked}
        value={props.value ?? ''}
        onFocus={props.onFocus}
        onChange={(event) => {
          props.onChoose(event.target.value === '' ? null : event.target.value);
        }}
      >
        <option value="">{props.none ?? 'Not set'}</option>
        {props.choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.title}
          </option>
        ))}
      </select>
    </div>
  );
}

function Words(
  props: Props & {
    readonly id: string;
    readonly label: string;
    readonly field: 'description' | 'agentBrief';
  },
): ReactElement {
  return (
    <div className="field">
      <label className="tf__k" htmlFor={props.id}>
        {props.label}
      </label>
      <textarea
        id={props.id}
        className="input"
        readOnly={props.locked}
        value={props.draft[props.field]}
        onChange={(event) => {
          props.put({ [props.field]: event.target.value });
        }}
      />
    </div>
  );
}

/** The Projects board's projects, read once `asked`; null until they answer. */
function useProjects(client: OperationsClient, asked: boolean) {
  const [answer, setAnswer] = useState<readonly Choice[] | 'failed' | null>(null);
  useEffect(() => {
    if (!asked) return;
    let live = true;
    void client.read<TaskBoardResult>('task.board', { board: null }).then((read) => {
      if (!live) return null;
      setAnswer(
        isRefusal(read) || isUnavailable(read)
          ? 'failed'
          : read.value.tasks.map((task) => ({ id: task.id, title: task.title ?? 'Untitled' })),
      );
      return null;
    });
    return () => {
      live = false;
    };
  }, [asked, client]);
  return answer;
}

function DraftProject(props: Props): ReactElement {
  const chosen = props.draft.boardId;
  const [asked, setAsked] = useState(chosen !== null);
  const answer = useProjects(props.client, asked);
  const offered = Array.isArray(answer) ? answer : [];
  const listed =
    chosen === null || offered.some((choice) => choice.id === chosen)
      ? offered
      : [...offered, { id: chosen, title: 'The project it was filed from' }];
  return (
    <>
      <Select
        id="panel-draft-board"
        label="Project"
        none="None"
        locked={props.locked}
        value={chosen}
        choices={listed}
        onFocus={() => {
          setAsked(true);
        }}
        onChoose={(boardId) => {
          props.put({ boardId });
        }}
      />
      {answer === 'failed' ? (
        <p className="card__sub">The project list could not be loaded.</p>
      ) : null}
    </>
  );
}
