// SPDX-License-Identifier: AGPL-3.0-only
//
// One run's observed layer on the task page, beside its receipts
// (run-progress.tsx): what the run's record says happened, in words.

import type { ReactElement } from 'react';
import type { ExecutionNode } from '../../../../packages/core-wire/src/index.ts';

/**
 * The run's observed layer (AW-06): what its record says happened, in words.
 * Silence is not a verdict (a quiet run reads in progress until something
 * recorded moves it), and money nobody recorded reads as not recorded, never 0.
 * The planned layer waits on the bound plan record, so nothing here says
 * planned or unplanned.
 */
export function Observed(props: { readonly node: ExecutionNode }): ReactElement {
  const { observed } = props.node;
  const money = (minor: number | null): string =>
    minor === null ? 'not recorded' : `${String(minor)} ${observed.currency} (minor units)`;
  return (
    <div className="sbact" data-observed={observed.condition}>
      <div className="sbact__row">
        <span className="sb__state">{observedWords(props.node)}</span>
      </div>
      {observed.fault === null ? null : (
        <div className="sbact__row" data-observed-fault="">
          <span className="sbact__meta">Dropped: {observed.fault}</span>
        </div>
      )}
      {observed.lease?.state === 'lapsed' ? (
        <div className="sbact__row" data-observed-lease="lapsed">
          <span className="sbact__meta">
            Its lease ran out at {observed.lease.expiresAt} and no drop is recorded yet.
          </span>
        </div>
      ) : null}
      <div className="sbact__row">
        <span className="sbact__meta">
          Held {money(observed.heldMinor)}; spent {money(observed.spentMinor)}.{' '}
          {observed.effectObserved ? 'Its effect was observed.' : 'No effect observed yet.'}
        </span>
      </div>
    </div>
  );
}

function observedWords(node: ExecutionNode): string {
  const { observed } = node;
  switch (observed.condition) {
    case 'not_started':
      return 'Not started';
    case 'in_progress':
      return observed.whoseMove === null
        ? 'In progress'
        : `In progress: the ${observed.whoseMove.kind === 'agent' ? "agent's" : "person's"} move`;
    case 'settled':
      return `Settled: ${observed.outcome ?? 'unknown'}`;
    case 'superseded':
      return 'Superseded by a later version';
    default:
      return observed.runState;
  }
}
