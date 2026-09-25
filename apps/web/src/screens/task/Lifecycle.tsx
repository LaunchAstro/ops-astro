// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's state buttons and its assignee picker.
//
// Each goes out through the operation that owns it: the state through
// `task.start`/`task.complete`/`task.reopen`, the assignee through
// `task.assign`. Both are disabled while a write is in flight or an edit is
// unsaved, and the page decides that; these only draw it.

import type { ReactElement } from 'react';
import type { PersonListResult, TaskDetail as Task } from '../../operations/shapes.ts';
import type { ReadState } from '../../data/authorised-read.ts';
import { RecordState } from '../../views/record-state.tsx';

export type LifecycleCommand = 'task.start' | 'task.complete' | 'task.reopen';

export interface LifecycleProps {
  readonly disabled: boolean;
  /**
   * The task is completed. Start is then not offered: the server refuses it
   * with TRANSITION_NOT_PERMITTED, because only task.reopen, with its reason,
   * clears the completion stamp (final review R2-RUNTIME-14).
   */
  readonly completed?: boolean;
  readonly onLifecycle: (command: LifecycleCommand) => void;
}

export function Lifecycle(props: LifecycleProps): ReactElement {
  return (
    <section className="sb__sect">
      <div className="sb__sh">
        <span className="sb__k">State</span>
      </div>
      <div className="btnrow">
        <button
          className="btn"
          type="button"
          data-lifecycle="start"
          disabled={props.disabled || props.completed === true}
          title={props.completed === true ? 'A completed task is reopened first.' : undefined}
          onClick={() => {
            props.onLifecycle('task.start');
          }}
        >
          Start
        </button>
        <button
          className="btn"
          type="button"
          data-lifecycle="complete"
          disabled={props.disabled}
          onClick={() => {
            props.onLifecycle('task.complete');
          }}
        >
          Complete
        </button>
        <button
          className="btn"
          type="button"
          data-lifecycle="reopen"
          disabled={props.disabled}
          onClick={() => {
            props.onLifecycle('task.reopen');
          }}
        >
          Reopen
        </button>
      </div>
    </section>
  );
}

export interface AssigneeProps {
  readonly people: ReadState<PersonListResult>;
  readonly onRetry: () => void;
  readonly assignee: Task['assignee'];
  readonly disabled: boolean;
  readonly onAssign: (personId: string) => void;
}

export function Assignee(props: AssigneeProps): ReactElement {
  return (
    <section className="sb__sect">
      <div className="sb__sh">
        <span className="sb__k">Assignee</span>
      </div>
      <RecordState state={props.people} subject="people" onRetry={props.onRetry}>
        {(value) => (
          <select
            className="input"
            aria-label="Assignee"
            disabled={props.disabled}
            value={props.assignee?.personId ?? ''}
            onChange={(event) => {
              props.onAssign(event.target.value);
            }}
          >
            <option value="">Unassigned</option>
            {value.persons.map((person) => (
              <option key={person.personId} value={person.personId}>
                {person.name}
              </option>
            ))}
          </select>
        )}
      </RecordState>
    </section>
  );
}
