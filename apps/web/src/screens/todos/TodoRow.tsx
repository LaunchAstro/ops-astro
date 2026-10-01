// SPDX-License-Identifier: AGPL-3.0-only
//
// One to-do (MP-7-1): the done tick, the name that opens the task in the dock
// task panel, its page door, the due as urgency words, the priority (which
// yields first under a 380px list) and the count of client messages waiting on
// the team, which scopes the list to this task.

import type { ReactElement } from 'react';
import type { TodoView } from '../../../../../packages/core-wire/src/index.ts';
import { pathTo } from '../../routes.ts';
import { URGENCY_WORDS, urgencyOf } from './todo-list.ts';

export interface TodoRowProps {
  readonly todo: TodoView;
  readonly today: string;
  readonly onTick: (todo: TodoView) => void;
  readonly onFocus: (key: string) => void;
  /** Absent where no dock task panel can open. */
  readonly onOpen?: (key: string) => void;
}

export function TodoRow(props: TodoRowProps): ReactElement {
  const { todo, onOpen } = props;
  const name = todo.title ?? todo.key;
  const urgency = urgencyOf(todo.due, props.today);
  return (
    <li className="todo" data-todo-row={todo.key}>
      <input
        type="checkbox"
        data-todo-tick
        aria-label={`Done: ${name}`}
        checked={false}
        onChange={() => {
          props.onTick(todo);
        }}
      />
      <button
        className="btn"
        type="button"
        data-todo-open
        disabled={onOpen === undefined}
        onClick={() => onOpen?.(todo.key)}
      >
        {name}
      </button>
      <a className="btn" data-todo-page href={pathTo('agency:task-detail', { key: todo.key })}>
        Open its page
      </a>
      <span data-todo-due data-urgency={urgency}>
        {URGENCY_WORDS[urgency]}
      </span>
      <span className="todo__priority" data-todo-priority>
        {todo.priority === null ? '' : `P${String(todo.priority)}`}
      </span>
      {todo.waitingComments > 0 ? (
        <button
          className="btn"
          type="button"
          data-todo-comments
          onClick={() => {
            props.onFocus(todo.key);
          }}
        >
          {todo.waitingComments} waiting
        </button>
      ) : null}
    </li>
  );
}
