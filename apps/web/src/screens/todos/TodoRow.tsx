// SPDX-License-Identifier: AGPL-3.0-only
//
// One to-do (MP-7-1), drawn as the mockup's Projects panel row (PJ-06 to
// PJ-11): the done tick, the assignee's face, the name, the count of client
// messages waiting on the team (which scopes the list to this task), the due
// as urgency words and the priority, which yields first under a 380px list.
//
// **The name is the task's own address.** A plain press opens the task in the
// dock task panel; a modified or middle press, or a press where no panel can
// open, follows the link to the task's page (the gesture law, R38).

import type { MouseEvent, ReactElement } from 'react';
import { Avatar } from '@launchastro/ui';
import type { TodoView } from '../../../../../packages/core-wire/src/index.ts';
import { pathTo } from '../../routes.ts';
import { URGENCY_WORDS, urgencyOf, type Urgency } from './todo-list.ts';

export interface TodoRowProps {
  readonly todo: TodoView;
  readonly today: string;
  readonly onTick: (todo: TodoView) => void;
  readonly onFocus: (key: string) => void;
  /** Absent where no dock task panel can open. */
  readonly onOpen?: (key: string) => void;
}

/** The due's tone: overdue in danger, today and overdue in the medium weight. */
const DUE_TONE: Readonly<Record<Urgency, string>> = {
  overdue: 'tl__due is-bad is-now',
  today: 'tl__due is-now',
  tomorrow: 'tl__due',
  week: 'tl__due',
  later: 'tl__due',
  none: 'tl__due',
};

/** A plain press: the main button with no modifier, which the panel takes. */
const plainPress = (event: MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

export function TodoRow(props: TodoRowProps): ReactElement {
  const { todo } = props;
  const name = todo.title ?? todo.key;
  const urgency = urgencyOf(todo.due, props.today);
  return (
    <li className="todo tl__row" data-todo-row={todo.key}>
      <button
        className="sbbox"
        type="button"
        role="checkbox"
        aria-checked="false"
        data-todo-tick
        aria-label={`Done: ${name}`}
        onClick={() => {
          props.onTick(todo);
        }}
      >
        <span className="sbbox__tick" aria-hidden="true">
          ✓
        </span>
      </button>
      <span className="tl__av">
        {todo.assignee === null ? null : <Avatar name={todo.assignee.name} />}
      </span>
      <TodoName {...props} name={name} />
      <Waiting {...props} />
      <span className={DUE_TONE[urgency]} data-todo-due data-urgency={urgency}>
        {URGENCY_WORDS[urgency]}
      </span>
      <span className="tl__pri todo__priority" data-todo-priority>
        {todo.priority === null ? null : (
          <>
            <span className="sline" />P{todo.priority}
          </>
        )}
      </span>
    </li>
  );
}

/** The name, the task's own address; a plain press opens it in the panel instead. */
function TodoName(props: TodoRowProps & { readonly name: string }): ReactElement {
  const { todo, onOpen } = props;
  return (
    <span className="tl__t">
      <a
        data-todo-open
        data-todo-page
        href={pathTo('agency:task-detail', { key: todo.key })}
        onClick={(event) => {
          if (onOpen === undefined || !plainPress(event)) return;
          event.preventDefault();
          onOpen(todo.key);
        }}
      >
        {props.name}
      </a>
    </span>
  );
}

/** The count of client messages waiting on the team; pressing it scopes the list to the task. */
function Waiting(props: TodoRowProps): ReactElement {
  const { todo } = props;
  const count = String(todo.waitingComments);
  return (
    <span className="tl__cmt">
      {todo.waitingComments > 0 ? (
        <button
          className="tl__cmtb"
          type="button"
          data-todo-comments
          aria-label={`${count} waiting: show only this task`}
          title={`${count} waiting on the team`}
          onClick={() => {
            props.onFocus(todo.key);
          }}
        >
          <span className="cbadge">{todo.waitingComments}</span>
        </button>
      ) : null}
    </span>
  );
}
