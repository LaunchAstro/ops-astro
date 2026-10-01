// SPDX-License-Identifier: AGPL-3.0-only
//
// The kit's layout blocks (MP-1-3): the table with its one head style, the
// card, and the three composites this unit owns (door card, list row, form
// layout). The rest of the blocks are in blocks.tsx, which exports these too.

import { type ReactElement, type ReactNode } from 'react';
import { DoorMark } from './marks.tsx';

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

/** DS-COMP-8: a card, row or strip that is itself a link. The arrow says it goes somewhere. */
export interface DoorCardProps {
  readonly href: string;
  readonly title: string;
  readonly sub?: string | undefined;
  readonly look?: 'card' | 'row' | 'cta' | undefined;
  readonly external?: boolean | undefined;
}

export function DoorCard(props: DoorCardProps): ReactElement {
  const look = props.look ?? 'card';
  return (
    <a
      className={`doorcard doorcard--${look}`}
      href={props.href}
      target={props.external === true ? '_blank' : undefined}
      rel={props.external === true ? 'noopener noreferrer' : undefined}
    >
      <span className="doorcard__title">
        {props.title}
        <DoorMark to={props.external === true ? 'external' : 'page'} />
      </span>
      {props.sub === undefined ? null : <span className="doorcard__sub">{props.sub}</span>}
    </a>
  );
}

/** DS-COMP-13: one row in a list that is not a board. */
export interface ListRowProps {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly lead?: ReactNode;
  readonly trail?: ReactNode;
  readonly look?: 'page' | 'panel' | 'notice' | 'record' | undefined;
  readonly state?: 'selected' | 'done' | 'archived' | 'gate' | undefined;
}

export function ListRow(props: ListRowProps): ReactElement {
  return (
    <li className={`lrow lrow--${props.look ?? 'page'}`} data-state={props.state}>
      {props.lead === undefined ? null : <span className="lrow__lead">{props.lead}</span>}
      <span className="lrow__main">
        <span className="lrow__title">{props.title}</span>
        {props.meta === undefined ? null : <span className="lrow__meta">{props.meta}</span>}
      </span>
      {props.trail === undefined ? null : <span className="lrow__trail">{props.trail}</span>}
    </li>
  );
}

/** DS-COMP-26: a tinted block of labelled fields in a grid, with its actions at the foot. */
export function FormLayout(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly actions: ReactNode;
  readonly onSubmit?: (() => void) | undefined;
}): ReactElement {
  return (
    <form
      className="form"
      aria-label={props.label}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit?.();
      }}
    >
      <div className="form__grid">{props.children}</div>
      <div className="form__actions">{props.actions}</div>
    </form>
  );
}
