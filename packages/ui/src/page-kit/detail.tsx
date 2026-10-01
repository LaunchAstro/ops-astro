// SPDX-License-Identifier: AGPL-3.0-only
//
// The row that opens to its detail and item list (CS-9.6). It is view state:
// open or shut, it saves nothing and records nothing.

import type { ReactElement, ReactNode } from 'react';

export interface DetailRowProps {
  readonly title: string;
  /** The right-hand figure on the summary line. */
  readonly trail?: ReactNode;
  readonly detail: ReactNode;
  readonly items?: readonly string[] | undefined;
  /** The state the page draws it in; shut when absent. */
  readonly open?: boolean | undefined;
}

export function DetailRow(props: DetailRowProps): ReactElement {
  const items = props.items ?? [];
  return (
    <details className="opp" open={props.open ?? false}>
      <summary className="opp__sum">
        <span className="opp__chev" aria-hidden="true">
          ›
        </span>
        <span className="opp__t">{props.title}</span>
        {props.trail === undefined ? null : <span className="opp__save">{props.trail}</span>}
      </summary>
      <div className="opp__body">
        <p className="opp__detail">{props.detail}</p>
        {items.length === 0 ? null : (
          <ul className="opp__items">
            {items.map((item, index) => (
              <li key={`${String(index)}:${item}`}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
