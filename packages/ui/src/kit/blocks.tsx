// SPDX-License-Identifier: AGPL-3.0-only
//
// The kit's blocks (MP-1-3): the pieces a page is laid out from. The table,
// cards, banners, meters and figures; the loading and error treatments (the
// one empty state is `Empty`, in primitives/Absence.tsx); the mock-data mark and the locate flash; and the three
// composites this unit owns (door card, list row, form layout).
//
// The table, cards and composites live in blocks-layout.tsx; this module
// exports them with its own.

import { type ReactElement, type ReactNode } from 'react';
import { IconButton } from './controls.tsx';
import { Term, type MarkTone } from './marks.tsx';

/**
 * DS-PRIM-22, and the section error of DS-PRIM-30 (`bad`). A tip is info with a
 * dismiss. `hint` is the agent's aside (DR-5): marked AI, and not a status.
 */
export interface BannerProps {
  readonly tone?: 'warn' | 'bad' | 'info' | 'hint' | undefined;
  readonly lead?: string | undefined;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly onDismiss?: (() => void) | undefined;
}

export function Banner(props: BannerProps): ReactElement {
  const tone = props.tone ?? 'warn';
  const Box = tone === 'hint' ? 'aside' : 'div';
  const role = tone === 'hint' ? undefined : tone === 'bad' ? 'alert' : 'status';
  return (
    <Box className={`banner banner--${tone}`} role={role}>
      {tone === 'hint' ? <span className="banner__mark">AI</span> : null}
      <p className="banner__body">
        {props.lead === undefined ? null : <strong>{props.lead} </strong>}
        {props.children}
      </p>
      {props.action}
      {props.onDismiss === undefined ? null : (
        <IconButton icon="cross-small" label="Dismiss" onClick={props.onDismiss} />
      )}
    </Box>
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

export * from './blocks-layout.tsx';
