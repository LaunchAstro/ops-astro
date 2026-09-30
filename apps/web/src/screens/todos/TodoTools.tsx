// SPDX-License-Identifier: AGPL-3.0-only
//
// The to-dos list's tools (MP-7-1, CS-7.23, CS-7.24): the token search and its
// "Reading this as" line, the today scope, dropping the scope, the sort and
// the door to the board. None of them writes.

import type { ReactElement } from 'react';
import { pathTo } from '../../routes.ts';
import type { SortKey } from './todo-list.ts';

export interface TodoToolsProps {
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly by: SortKey;
  readonly onSort: (by: SortKey) => void;
  /** The scope read back, or null when nothing scopes the list. */
  readonly reading: string | null;
  readonly onClear: () => void;
}

const SORTS: readonly { readonly key: SortKey; readonly label: string }[] = [
  { key: 'due', label: 'Due' },
  { key: 'task', label: 'Task' },
  { key: 'priority', label: 'Priority' },
];

export function TodoTools(props: TodoToolsProps): ReactElement {
  return (
    <div className="todos__tools">
      <input
        id="todos-search"
        className="input"
        type="search"
        aria-label="Search my to-dos: words, tag:name, due:today"
        value={props.query}
        onChange={(event) => {
          props.onQuery(event.target.value);
        }}
      />
      <button
        className="btn"
        type="button"
        data-todos="today"
        onClick={() => props.onQuery('due:today')}
      >
        Today
      </button>
      <select
        id="todos-sort"
        className="input"
        aria-label="Sort by"
        value={props.by}
        onChange={(event) => {
          props.onSort(SORTS.find((sort) => sort.key === event.target.value)?.key ?? 'due');
        }}
      >
        {SORTS.map((sort) => (
          <option key={sort.key} value={sort.key}>
            {sort.label}
          </option>
        ))}
      </select>
      <a className="btn" data-todos="board" href={pathTo('agency:projects-board')}>
        Open the board
      </a>
      <Reading reading={props.reading} onClear={props.onClear} />
    </div>
  );
}

function Reading(props: {
  readonly reading: string | null;
  readonly onClear: () => void;
}): ReactElement | null {
  if (props.reading === null) return null;
  return (
    <p className="card__sub">
      <span data-todos-reading>{props.reading}</span>{' '}
      <button className="btn" type="button" data-todos="clear" onClick={props.onClear}>
        Drop the scope
      </button>
    </p>
  );
}
