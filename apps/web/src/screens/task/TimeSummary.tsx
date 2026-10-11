// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import { LATEST_TIME_ENTRIES, minutesText, burnOf } from './time-format.ts';
export function Totals(props: {
  readonly total: number;
  readonly estimate: number | null;
}): ReactElement {
  const burn = burnOf(props.total, props.estimate);
  return (
    <>
      <span className="card__sub" data-time-total>
        {minutesText(props.total)}
        {props.estimate === null ? ' logged' : ` of ${minutesText(props.estimate)}`}
      </span>
      {burn === null ? null : (
        <div className="sb__burn" data-time-burn data-danger={burn.danger} aria-hidden="true">
          <span style={{ width: `${String(burn.percent)}%` }} />
        </div>
      )}
    </>
  );
}

/** The latest three, then every entry on request (CS-4.31); nothing to fold at three or fewer. */
export function Fold(props: {
  readonly count: number;
  readonly open: boolean;
  readonly onOpen: (value: boolean) => void;
}): ReactElement | null {
  if (props.count <= LATEST_TIME_ENTRIES) return null;
  return (
    <button
      type="button"
      className="btn btn--ghost"
      data-time-fold
      aria-expanded={props.open}
      onClick={() => props.onOpen(!props.open)}
    >
      {props.open ? 'Show latest three' : `Show all (${String(props.count)})`}
    </button>
  );
}
