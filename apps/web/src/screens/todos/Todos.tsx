// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects dock panel, the reader's own to-dos (MP-7-1, CS-7.23): the
// open tasks assigned to the reader (`task.todos`), each a real task whose
// name opens it in the dock task panel and whose tick completes it through
// `task.complete`, the one completion transition. The list's logic (due
// urgency, the typed scope, the sorts) is `todo-list.ts`. Scoped (MP-7-2) to a
// teammate or a client by the switch or by the door that opened it
// (`todo-scope.ts`, `TodoScopeSwitch.tsx`).
//
// Typed identities send authorised reads; local filters remain view state.
// The sort, chosen by the column heads, is the person's own `todos.sort`
// preference (CS-7.24, not audited), so it is the same after a reload. Only
// the tick sends a task mutation. These choices are kept above the checked
// read. A scope or vocabulary refresh hides the old rows while permission is
// rechecked; completion keeps its current answer while reading back.

import { useEffect, useState, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import type { TaskTodosResult, TodoView } from '../../../../../packages/core-wire/src/index.ts';
import { dependencyAdmission } from '../../data/board-live.ts';
import { useTodoDependencies, type TodoDependency } from './todo-dependencies.ts';
import { useRead } from '../../data/use-read.ts';
import { BoardEditRecoveries, useBoardEdits } from '../projects/board-edit-context.tsx';
import { RecordState } from '../../views/record-state.tsx';
import { todayOn } from '../task/due-dates.ts';
import { readingOf, scoped, sorted, type Chip } from './todo-list.ts';
import { TodoHead, useTodoSort, type TodoOrder } from './TodoHead.tsx';
import { TodoRow, type TodoRowProps } from './TodoRow.tsx';
import { TodoTools } from './TodoTools.tsx';
import { compactBoardAddress } from '../projects/scoped-board.ts';
import { TodoScopeSwitch } from './TodoScopeSwitch.tsx';
import {
  admittedChips,
  admittedWords,
  scopedBody,
  typedScope,
  useTodoVocabulary,
} from './typed-scope.ts';
import { MINE, narrowed, waitingOf, type TodoScope } from './todo-scope.ts';

export interface TodosScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  /** Open a task in the dock task panel; absent where no panel can open. */
  readonly onOpen?: (key: string) => void;
  /** The panel host's change count: a write in the task panel reads the list again. */
  readonly changes?: number;
  /** The clock the business day is read on; the real one unless a test fixes it. */
  readonly now?: () => Date;
  /**
   * The scope a door opens the panel with (MP-7-2): the seam the Team and
   * Clients panels call. The reader's own list when absent.
   */
  readonly scope?: TodoScope;
}

export function TodosScreen(props: TodosScreenProps): ReactElement {
  return <TodosOwner key={`${props.grantKey}:${JSON.stringify(props.scope ?? MINE)}`} {...props} />;
}
function useTodoFilters(props: TodosScreenProps) {
  const [scope, setScope] = useState<TodoScope>(props.scope ?? MINE);
  const [query, setQuery] = useState('');
  const [chips, setChips] = useState<readonly Chip[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const vocabulary = useTodoVocabulary(props.client, props.grantKey, props.changes ?? 0);
  const currentChips = admittedChips(chips, vocabulary);
  const filters = [...currentChips, ...typedScope(query, vocabulary)];
  const read = scopedBody(scope, filters, vocabulary);
  const intent = JSON.stringify([scope, query, chips]);
  const interpretation = scopedWords(admittedWords(scope, vocabulary), filters, focus);
  const boardAddress = compactBoardAddress(read, scope, filters, focus);
  const tools = {
    ...(boardAddress === undefined ? {} : { boardAddress }),
    query,
    onQuery: setQuery,
    chips: currentChips,
    onCommit: () => {
      setChips(filters);
      setQuery('');
    },
    onRemove: (index: number) => setChips(chips.filter((_, at) => at !== index)),
    reading: interpretation || null,
    onClear: () => {
      setQuery('');
      setChips([]);
      setFocus(null);
    },
  };
  return {
    scope,
    setScope,
    vocabulary,
    intent,
    filters,
    read,
    focus,
    setFocus,
    tools,
    setChips,
    setQuery,
  };
}
function scopedWords(scope: string | null, filters: readonly Chip[], focus: string | null): string {
  return [scope, readingOf(filters, focus)].filter((part) => part !== null).join(', ');
}
function TodosOwner(props: TodosScreenProps): ReactElement {
  const {
    scope,
    setScope,
    vocabulary,
    intent,
    filters,
    read,
    focus,
    setFocus,
    tools,
    setChips,
    setQuery,
  } = useTodoFilters(props);
  const order = useTodoSort(props.client, props.grantKey);
  const onDependency = useTodoDependencies(props, read, vocabulary, intent);
  return (
    <section className="todos stack" aria-label={admittedWords(scope, vocabulary) ?? 'My to-dos'}>
      <TodoScopeSwitch scope={scope} onScope={setScope} vocabulary={vocabulary} />
      <TodoTools {...tools} />
      <IdentityChoices
        filters={filters}
        onChoose={(next) => {
          setChips(next);
          setQuery('');
        }}
      />
      {read.blocked ? (
        <p data-todos-empty>No to-dos here. Resolve the scope to read matching work.</p>
      ) : (
        <ScopedTodos
          key={`${JSON.stringify(read.body)}:${String(vocabulary.version)}`}
          {...props}
          scope={scope}
          onDependency={onDependency}
          body={read.body}
          filters={filters}
          order={order}
          focus={focus}
          onFocus={setFocus}
        />
      )}
    </section>
  );
}
function IdentityChoices(props: {
  readonly filters: readonly Chip[];
  readonly onChoose: (next: readonly Chip[]) => void;
}): ReactElement {
  return (
    <>
      {props.filters.map((chip, index) =>
        chip.kind === 'unresolved' ? (
          <div key={index} role="status">
            {chip.reason}
            {chip.choices.map((choice) => (
              <button
                key={`${choice.kind}:${choice.value}`}
                type="button"
                className="btn"
                data-todos-identity={choice.value}
                onClick={() =>
                  props.onChoose(props.filters.map((each, at) => (at === index ? choice : each)))
                }
              >
                {choice.kind}: {choice.name} ({choice.value})
              </button>
            ))}
          </div>
        ) : null,
      )}
    </>
  );
}
type ScopedTodosProps = TodosScreenProps & {
  readonly scope: TodoScope;
  readonly body: Readonly<Record<string, string>>;
  readonly filters: readonly Chip[];
  readonly order: TodoOrder;
  readonly focus: string | null;
  readonly onFocus: (key: string | null) => void;
  readonly onDependency: TodoDependency;
};
function ScopedTodos(props: ScopedTodosProps): ReactElement {
  const { state, reload, own } = useRead<TaskTodosResult>({
    grantKey: props.grantKey,
    run: () => props.client.read<TaskTodosResult>('task.todos', props.body),
    deps: [props.client],
  });
  const admission = own ? dependencyAdmission(state, true) : 'recovering';
  useEffect(() => props.onDependency(admission), [props.onDependency, admission]);
  const edits = useBoardEdits(props.client, props.grantKey);
  const { because, tick } = useTick(edits, reload);
  const today = todayOn((props.now ?? realTime)());
  return (
    <RecordState state={state} subject="to-dos" onRetry={reload} keep>
      {(value) => {
        const rows = sorted(
          scoped(narrowed(value.todos, props.scope), props.filters, props.focus, today),
          props.order.sort,
        );
        return (
          <>
            <BoardEditRecoveries custody={edits.custody} tasks={rows} />
            <WaitingCount client={props.body['client'] !== undefined} waiting={waitingOf(rows)} />
            {because === null ? null : (
              <p className="field__error" role="alert" data-todos-refusal>
                {because}
              </p>
            )}
            <div className="dp__list">
              <div className="tl">
                <TodoHead order={props.order} />
                <TodoRows
                  rows={rows}
                  today={today}
                  onTick={tick}
                  onFocus={props.onFocus}
                  {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
                />
              </div>
            </div>
          </>
        );
      }}
    </RecordState>
  );
}

/** A client's messages owed a reply, from the list's own read; absent at zero. */
function WaitingCount(props: { readonly client: boolean; readonly waiting: number }) {
  if (!props.client || props.waiting === 0) return null;
  return (
    <p className="card__sub" data-todos-waiting-count>
      {props.waiting} {props.waiting === 1 ? 'message' : 'messages'} waiting on us
    </p>
  );
}

const realTime = (): Date => new Date();

/**
 * The tick: `task.complete` at the row's revision; a landed one reads the list
 * again. The completed row stays drawn while that reread is in flight, so its
 * revision is spent: a second tick on it sends nothing.
 */
function useTick(edits: ReturnType<typeof useBoardEdits>, reload: () => void) {
  const [because, setBecause] = useState<string | null>(null);
  const [spent, setSpent] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(
    () =>
      edits.custody.settled((entry, answer) => {
        setBecause(answer.kind === 'ok' ? null : answer.because);
        if (answer.kind !== 'ok') return;
        reload();
        if (entry.attempt.command === 'task.complete')
          setSpent((was) =>
            new Set(was).add(
              `${entry.attempt.body.recordId}@${String(entry.attempt.expectedRevision)}`,
            ),
          );
      }),
    [edits.custody, reload],
  );
  const tick = (todo: TodoView): void => {
    if (spent.has(`${todo.id}@${String(todo.revision)}`)) return;
    edits.custody.choose({ command: 'task.complete', body: { recordId: todo.id } }, todo.revision);
  };
  return { because, tick };
}

function TodoRows(
  props: Omit<TodoRowProps, 'todo'> & { readonly rows: readonly TodoView[] },
): ReactElement {
  const { rows, ...row } = props;
  return rows.length === 0 ? (
    <div data-todos-empty>
      <Empty look="inline" title="No to-dos here." />
    </div>
  ) : (
    <ul className="todos__list">
      {rows.map((todo) => (
        <TodoRow key={todo.id} todo={todo} {...row} />
      ))}
    </ul>
  );
}
