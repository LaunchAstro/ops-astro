// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects dock panel, the reader's own to-dos (MP-7-1, CS-7.23): the
// open tasks assigned to the reader (`task.todos`), each a real task whose
// name opens it in the dock task panel and whose tick completes it through
// `task.complete`, the one completion transition. The list's logic (due
// urgency, the typed scope, the sorts) is `todo-list.ts`.
//
// **Reading writes nothing.** Search, the today scope, the comment-count
// scope and the sort are view state and send nothing; only the tick writes.
//
// **The sort is kept for the session.** Remembering it for the person
// (CS-7.24, `preference saved`) leans on the preference store (MP-2-11a),
// which is not on this branch's base; until it is, the choice lasts as long
// as the panel does.

import { useState, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { TaskTodosResult, TodoView } from '../../../../../packages/core-wire/src/index.ts';
import { useRead } from '../../data/use-read.ts';
import { useCommand } from '../../records/use-command.ts';
import { RecordState } from '../../views/record-state.tsx';
import { todayOn } from '../task/due-dates.ts';
import { readingOf, scopeOf, scoped, sorted, type SortKey } from './todo-list.ts';
import { TodoRow, type TodoRowProps } from './TodoRow.tsx';
import { TodoTools } from './TodoTools.tsx';

export interface TodosScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** Open a task in the dock task panel; absent where no panel can open. */
  readonly onOpen?: (key: string) => void;
  /** The panel host's change count: a write in the task panel reads the list again. */
  readonly changes?: number;
  /** The clock the business day is read on; the real one unless a test fixes it. */
  readonly now?: () => Date;
}

export function TodosScreen(props: TodosScreenProps): ReactElement {
  const { client } = props;
  const { state, reload } = useRead<TaskTodosResult>({
    grantKey: props.grantKey,
    run: () => client.read<TaskTodosResult>('task.todos', {}),
    deps: [props.changes ?? 0],
  });
  return (
    <section className="todos stack" aria-label="My to-dos">
      <RecordState state={state} subject="to-dos" onRetry={reload}>
        {(value) => <TodoList {...props} todos={value.todos} reload={reload} />}
      </RecordState>
    </section>
  );
}

const realTime = (): Date => new Date();

/** The tick: `task.complete` at the row's revision; a landed one reads the list again. */
function useTick(client: OperationsClient, reload: () => void) {
  const { because, run } = useCommand();
  const tick = (todo: TodoView): void => {
    run(
      () =>
        client.mutate('task.complete', { recordId: todo.id }, { expectedRevision: todo.revision }),
      (settlement) => {
        if (settlement.kind === 'ok') reload();
      },
    );
  };
  return { because, tick };
}

function TodoList(
  props: TodosScreenProps & { readonly todos: readonly TodoView[]; readonly reload: () => void },
): ReactElement {
  const [query, setQuery] = useState('');
  const [by, setBy] = useState<SortKey>('due');
  const [focus, setFocus] = useState<string | null>(null);
  const { because, tick } = useTick(props.client, props.reload);
  const today = todayOn((props.now ?? realTime)());
  const scope = scopeOf(query);
  return (
    <>
      <TodoTools
        query={query}
        onQuery={setQuery}
        by={by}
        onSort={setBy}
        reading={readingOf(scope, focus)}
        onClear={() => {
          setQuery('');
          setFocus(null);
        }}
      />
      {because === null ? null : (
        <p className="field__error" role="alert" data-todos-refusal>
          {because}
        </p>
      )}
      <TodoRows
        rows={sorted(scoped(props.todos, scope, focus, today), by)}
        today={today}
        onTick={tick}
        onFocus={setFocus}
        {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
      />
    </>
  );
}

function TodoRows(
  props: Omit<TodoRowProps, 'todo'> & { readonly rows: readonly TodoView[] },
): ReactElement {
  const { rows, ...row } = props;
  return rows.length === 0 ? (
    <p className="card__sub" data-todos-empty>
      No to-dos here.
    </p>
  ) : (
    <ul className="todos__list">
      {rows.map((todo) => (
        <TodoRow key={todo.id} todo={todo} {...row} />
      ))}
    </ul>
  );
}
