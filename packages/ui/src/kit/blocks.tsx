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
 * DS-PRIM-29 (DR-37). A skeleton stands where content will be, at its size:
 * `field` is the shape of a 38 input, `line` a line of text, `tile` a KPI.
 * The words for a screen reader live in the status region around it.
 */
export function Skeleton(props: { readonly shape: 'field' | 'line' | 'tile' }): ReactElement {
  return <span className={`skel skel--${props.shape}`} aria-hidden="true" />;
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

export * from './blocks-layout.tsx';
