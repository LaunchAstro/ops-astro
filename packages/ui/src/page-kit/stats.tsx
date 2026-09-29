// SPDX-License-Identifier: AGPL-3.0-only
//
// The stat row (DS-COMP-6) and the KPI tile it holds (DS-PRIM-24), with the
// delta, the term tip and the of-track. The tile's markup is the kit's `stat`
// and its track the kit's stat meter (DS-PRIM-23), so the row places the kit's
// parts rather than drawing its own.

import type { ReactElement, ReactNode } from 'react';
import { PageTerm } from './term.tsx';

export interface StatDelta {
  /** Signed change against `period`. */
  readonly value: number;
  readonly period: string;
}

export interface StatProps {
  readonly label: string;
  readonly value: number;
  readonly suffix?: string | undefined;
  /** The whole the value counts towards: drawn as `of n`, and the track's end. */
  readonly of?: number | undefined;
  /** Draw the of-track. Without a positive `of` there is nothing to draw it against. */
  readonly track?: boolean | undefined;
  /** The plain-words definition of the label. */
  readonly term?: string | undefined;
  readonly delta?: StatDelta | undefined;
}

const figure = (value: number): string => value.toLocaleString('en-AU');

function Delta(props: { readonly delta: StatDelta }): ReactElement {
  const { value, period } = props.delta;
  const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return (
    <span className={`delta delta--${direction}`}>
      {`${sign}${figure(Math.abs(value))} on ${period}`}
    </span>
  );
}

export function Stat(props: StatProps): ReactElement {
  const of = props.of;
  const share =
    of !== undefined && of > 0 ? Math.min(100, Math.max(0, (props.value / of) * 100)) : undefined;
  return (
    <div className="stat">
      <span className="stat__label">
        {props.term === undefined ? (
          props.label
        ) : (
          <PageTerm definition={props.term}>{props.label}</PageTerm>
        )}
      </span>
      <span className="stat__num">
        {figure(props.value)}
        {props.suffix === undefined ? null : <span className="stat__suffix">{props.suffix}</span>}
        {of === undefined ? null : <span className="stat__of"> of {figure(of)}</span>}
      </span>
      {props.track !== true || share === undefined || of === undefined ? null : (
        <span
          className="meter meter--stat"
          role="meter"
          aria-label={props.label}
          aria-valuemin={0}
          aria-valuemax={of}
          aria-valuenow={props.value}
        >
          <span
            className="meter__fill"
            style={{ width: `${String(Math.round(share * 10) / 10)}%` }}
          />
        </span>
      )}
      {props.delta === undefined ? null : (
        <span className="stat__foot">
          <Delta delta={props.delta} />
        </span>
      )}
    </div>
  );
}

export function StatRow(props: {
  /** How many figures the row holds at full width, two to six. */
  readonly columns: 2 | 3 | 4 | 5 | 6;
  readonly children: ReactNode;
}): ReactElement {
  return <div className={`statrow statrow--${String(props.columns)}`}>{props.children}</div>;
}
