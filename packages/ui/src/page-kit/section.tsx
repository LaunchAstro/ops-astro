// SPDX-License-Identifier: AGPL-3.0-only
//
// The page kit's section parts: the section head (DS-COMP-4), the disclosure
// layer (DS-COMP-12) and the hint, the agent's aside (DS-PRIM-22's `hint`).

import type { ReactElement, ReactNode } from 'react';
import { SectionTip, type Tip, type TipPreferences } from './tips.tsx';

/** A section's index as the head draws it: three digits, counted top to bottom. */
export function sectionIndex(position: number): string {
  if (!Number.isInteger(position) || position < 1 || position > 999) {
    throw new RangeError(
      `a section index is a whole number from 1 to 999, not ${String(position)}`,
    );
  }
  return String(position).padStart(3, '0');
}

export interface SectionHeadProps {
  /** From `sectionIndex`, or `!` and `?` for the alert index. */
  readonly index: string;
  readonly title: string;
  /** The right-hand marker or a status chip. */
  readonly right?: ReactNode;
  readonly tip?: Tip | undefined;
  readonly preferences?: TipPreferences | undefined;
}

export function SectionHead(props: SectionHeadProps): ReactElement {
  return (
    <header className="sec">
      <div className="sec__meta">
        <span className="marker">{props.index}</span>
        {props.right === undefined ? null : <span className="sec__right">{props.right}</span>}
      </div>
      <h2 className="sec__head">{props.title}</h2>
      {props.tip === undefined || props.preferences === undefined ? null : (
        <SectionTip tip={props.tip} preferences={props.preferences} />
      )}
    </header>
  );
}

export interface LayerProps {
  /** The layer's place in its page, counted from 1. */
  readonly order: number;
  readonly title: string;
  readonly count?: number | undefined;
  /** The state the page draws it in; without one, a third or later layer starts shut. */
  readonly open?: boolean | undefined;
  readonly children?: ReactNode;
}

export function Layer(props: LayerProps): ReactElement {
  const open = props.open ?? props.order < 3;
  return (
    <details className="layer" open={open}>
      <summary className="layer__sum">
        <span className="layer__title">{props.title}</span>
        {props.count === undefined ? null : <span className="layer__count">{props.count}</span>}
        <span className="layer__chev" aria-hidden="true" />
      </summary>
      <div className="layer__body">{props.children}</div>
    </details>
  );
}

export interface HintAction {
  readonly label: string;
  readonly run: () => void;
}

/** A hint draws a button only with an action to run; there is no inert one. */
export function Hint(props: {
  readonly text: string;
  readonly action?: HintAction | undefined;
}): ReactElement {
  return (
    <aside className="hint">
      <span className="hint__text">{props.text}</span>
      {props.action === undefined ? null : (
        <button type="button" className="hint__act" onClick={props.action.run}>
          {props.action.label}
        </button>
      )}
    </aside>
  );
}
