// SPDX-License-Identifier: AGPL-3.0-only
//
// The to-do list's column heads (PJ-05), a list row (DS-COMP-13) of the kit's
// sort buttons: Task, the comment column, Due and Priority. A head sorts by
// its column; pressed again, it reverses. The Priority head yields with its
// column under a 380px list.
//
// The sort is the person's own `todos.sort` preference (CS-7.24, not
// audited), read once and saved on each press (`usePreferences`), so a reload
// draws it. A choice made before the read answers stands; a refused save is
// said above the heads. A first read that fails is not said: the list keeps
// the default sort, due earliest first.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { usePreferences } from '../../data/use-preferences.ts';
import { nextSort, sortOf, type SortKey, type TodoSort } from './todo-list.ts';

export interface TodoOrder {
  readonly sort: TodoSort;
  readonly onSort: (key: SortKey) => void;
  readonly because: string | null;
}

export function useTodoSort(client: OperationsClient, grantKey: string): TodoOrder {
  const { preferences, because, save } = usePreferences(client, grantKey);
  const sort = sortOf(preferences?.['todos.sort']);
  return {
    sort,
    onSort: (key) => {
      save('todos.sort', nextSort(sort, key));
    },
    because: preferences === null ? null : because,
  };
}

const HEADS: readonly { readonly key: SortKey; readonly label: string }[] = [
  { key: 'task', label: 'Task' },
  { key: 'due', label: 'Due' },
  { key: 'priority', label: 'Priority' },
];

export function TodoHead(props: { readonly order: TodoOrder }): ReactElement {
  const { sort, onSort, because } = props.order;
  const [task, due, priority] = HEADS.map((head) => {
    const on = sort.key === head.key;
    const way = sort.direction === 'asc' ? 'ascending' : 'descending';
    return (
      <button
        key={head.key}
        type="button"
        className={`table__sort${on ? ' is-sort' : ''}${head.key === 'priority' ? ' todo__priority' : ''}`}
        data-todos-sort={head.key}
        aria-label={`Sort by ${head.label}${on ? `, now ${way}` : ''}`}
        onClick={() => onSort(head.key)}
      >
        {head.label}
        {on ? <span aria-hidden="true">{sort.direction === 'asc' ? ' ↑' : ' ↓'}</span> : null}
      </button>
    );
  });
  return (
    <>
      {because === null ? null : (
        <p className="field__error" role="alert" data-todos-sort-refusal>
          {because}
        </p>
      )}
      <div className="tl__row" data-todos-heads>
        <span />
        <span />
        {task}
        <span />
        {due}
        {priority}
      </div>
    </>
  );
}
