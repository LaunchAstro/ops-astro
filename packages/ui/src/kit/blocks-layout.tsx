// SPDX-License-Identifier: AGPL-3.0-only
//
// The kit's layout blocks (MP-1-3): the table with its one head style, the
// card, and the three composites this unit owns (door card, list row, form
// layout). The rest of the blocks are in blocks.tsx, which exports these too.

import { type ReactElement, type ReactNode } from 'react';

/** DS-PRIM-20. One head style for every table (the mockup's two dialects become this one). */
export interface Column {
  readonly key: string;
  readonly label: string;
  readonly align?: 'start' | 'end' | 'centre' | undefined;
  /** Sortable heads are buttons, so a keyboard can reach them. */
  readonly sort?: 'ascending' | 'descending' | 'none' | undefined;
  readonly onSort?: (() => void) | undefined;
}

export interface TableProps {
  readonly caption: string;
  readonly columns: readonly Column[];
  readonly rows: readonly Readonly<Record<string, ReactNode>>[];
  readonly dense?: boolean | undefined;
  /** The one export control a table carries in its head slot (C15), when it offers one. */
  readonly exportControl?: ReactNode;
}

const alignClass = (align: Column['align']): string | undefined =>
  align === 'end' ? 'r' : align === 'centre' ? 'c' : undefined;

export function Table(props: TableProps): ReactElement {
  return (
    <div className="tablewrap">
      {props.exportControl === undefined ? null : (
        <div className="table__tools">{props.exportControl}</div>
      )}
      <table className={props.dense === true ? 'table table--dense' : 'table'}>
        <caption className="visually-hidden">{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={alignClass(column.align)}
                aria-sort={column.sort === undefined ? undefined : column.sort}
              >
                {column.onSort === undefined ? (
                  column.label
                ) : (
                  <button type="button" className="table__sort" onClick={column.onSort}>
                    {column.label}
                    <span className="table__arrow" aria-hidden="true">
                      {column.sort === 'descending' ? '↓' : '↑'}
                    </span>
                  </button>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, index) => (
            <tr key={index}>
              {props.columns.map((column) => (
                <td key={column.key} className={alignClass(column.align)}>
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** DS-PRIM-21 and DS-COMP-7. */
export interface CardProps {
  readonly title?: string | undefined;
  readonly sub?: string | undefined;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  /** Rows run to the edge (a list card). */
  readonly flush?: boolean | undefined;
  /** The current choice in a set of cards: accent border and a 3px inset rule (DR-9). */
  readonly current?: boolean | undefined;
}

export function Card(props: CardProps): ReactElement {
  const classes = ['card'];
  if (props.flush === true) classes.push('card--flush');
  if (props.current === true) classes.push('card--current');
  return (
    <section className={classes.join(' ')}>
      {props.title === undefined ? null : (
        <div className="card__head">
          <div>
            <h3 className="card__title">{props.title}</h3>
            {props.sub === undefined ? null : <p className="card__sub">{props.sub}</p>}
          </div>
          {props.actions}
        </div>
      )}
      {props.children}
    </section>
  );
}
