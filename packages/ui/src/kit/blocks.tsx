// SPDX-License-Identifier: AGPL-3.0-only
//
// The kit's blocks (MP-1-3): the pieces a page is laid out from. The table,
// cards, banners, meters and figures; the loading and error treatments (the
// one empty state is `Empty`, in primitives/Absence.tsx); the mock-data mark and the locate flash; and the three
// composites this unit owns (door card, list row, form layout).

import { type ReactElement, type ReactNode } from 'react';
import { IconButton } from './controls.tsx';
import { DoorMark, Term, type MarkTone } from './marks.tsx';

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

/** DS-PRIM-22, and the section error of DS-PRIM-30 (`bad`). A tip is info with a dismiss. */
export interface BannerProps {
  readonly tone?: 'warn' | 'bad' | 'info' | undefined;
  readonly lead?: string | undefined;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly onDismiss?: (() => void) | undefined;
}

export function Banner(props: BannerProps): ReactElement {
  const tone = props.tone ?? 'warn';
  return (
    <div className={`banner banner--${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <p className="banner__body">
        {props.lead === undefined ? null : <strong>{props.lead} </strong>}
        {props.children}
      </p>
      {props.action}
      {props.onDismiss === undefined ? null : (
        <IconButton icon="cross-small" label="Dismiss" onClick={props.onDismiss} />
      )}
    </div>
  );
}

/**
 * DS-PRIM-23. The fill's width is worked out from the value and the whole it is
 * drawn beside, never passed in, so the bar cannot disagree with the number.
 */
export interface MeterProps {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly tone?: MarkTone | undefined;
  readonly look?: 'meter' | 'stat' | 'time' | undefined;
  /** A target tick, in the same units. */
  readonly target?: number | undefined;
  readonly over?: boolean | undefined;
}

const share = (value: number, max: number): number =>
  max > 0 && Number.isFinite(value) ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

export function Meter(props: MeterProps): ReactElement {
  const classes = [`meter meter--${props.look ?? 'meter'}`];
  if (props.tone !== undefined) classes.push(`is-${props.tone}`);
  if (props.over === true) classes.push('is-over');
  return (
    <span
      className={classes.join(' ')}
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={props.max}
      aria-valuenow={props.value}
    >
      <span
        className="meter__fill"
        style={{ width: `${String(share(props.value, props.max))}%` }}
      />
      {props.target === undefined ? null : (
        <span
          className="meter__target"
          style={{ left: `${String(share(props.target, props.max))}%` }}
        />
      )}
    </span>
  );
}

/** DS-PRIM-24. Not interactive; the label can explain itself with a term. */
export interface KpiProps {
  readonly label: string;
  readonly explain?: string | undefined;
  readonly value: string;
  readonly of?: string | undefined;
  readonly track?: { readonly value: number; readonly max: number } | undefined;
  readonly delta?: string | undefined;
}

export function Kpi(props: KpiProps): ReactElement {
  return (
    <div className="stat">
      <span className="stat__label">
        {props.explain === undefined ? props.label : <Term tip={props.explain}>{props.label}</Term>}
      </span>
      <span className="stat__num">
        {props.value}
        {props.of === undefined ? null : <span className="stat__of"> of {props.of}</span>}
      </span>
      {props.track === undefined ? null : (
        <Meter label={props.label} look="stat" value={props.track.value} max={props.track.max} />
      )}
      {props.delta === undefined ? null : <span className="stat__foot">{props.delta}</span>}
    </div>
  );
}

/**
 * DS-PRIM-29 (DR-37). A skeleton stands where content will be, at its size:
 * `field` is the shape of a 38 input, `line` a line of text, `tile` a KPI.
 * The words for a screen reader live in the status region around it.
 */
export function Skeleton(props: { readonly shape: 'field' | 'line' | 'tile' }): ReactElement {
  return <span className={`skel skel--${props.shape}`} aria-hidden="true" />;
}

/** DS-PRIM-30's inline row note: deliberately not red, the row's own mark carries the tone (DR-38). */
export function RowNote(props: { readonly children: ReactNode }): ReactElement {
  return <p className="rownote">{props.children}</p>;
}

/**
 * DS-PRIM-32. Marks a region whose values are sample data. Only a demo
 * install has any (R56); on a real client nothing is sample, so nothing is
 * marked. `nested` keeps only the edge inside a marked region.
 */
export function MockRegion(props: {
  readonly children: ReactNode;
  readonly nested?: boolean | undefined;
  readonly word?: boolean | undefined;
}): ReactElement {
  return (
    <div className={props.nested === true ? 'is-mock is-mock--nested' : 'is-mock'}>
      {props.word === true ? <span className="mocktag">Mock</span> : null}
      {props.children}
    </div>
  );
}

/**
 * DS-PRIM-33: pulse one accent ring on the element a deep link landed on, once,
 * after bringing it to the middle of the screen.
 */
export function locate(target: HTMLElement): void {
  target.classList.remove('flash-target');
  // Reading layout restarts the animation when the same target is located twice.
  void target.offsetWidth;
  target.classList.add('flash-target');
  target.addEventListener(
    'animationend',
    () => {
      target.classList.remove('flash-target');
    },
    { once: true },
  );
  target.scrollIntoView({ block: 'center' });
}

/** DS-PRIM-19's popover: a small panel under its trigger (the filter menu). */
export function Popover(props: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="popover" role="dialog" aria-label={props.label}>
      {props.children}
    </div>
  );
}
