// SPDX-License-Identifier: AGPL-3.0-only
//
// The Work log's lines around its days (MP-8-4): what the search was read as,
// how many events pass, and what shows when nothing passes.

import type { ReactElement } from 'react';
import { Empty } from '@launchastro/ui';

/**
 * What the search was read as, and how many events pass of those in view.
 * No time is tracked in the ledger yet, so the count line never sums any.
 * `partial`: the search's matches go past what it reads (C1's bound, 500),
 * so some are not listed and the count says so.
 */
export function SearchLines(props: {
  readonly reading: string | null;
  readonly passed: number;
  readonly inView: number;
  readonly partial: boolean;
}): ReactElement {
  return (
    <>
      {props.reading === null ? null : (
        <p className="act__read" data-ledger-read>
          {props.reading}
        </p>
      )}
      {props.inView === 0 ? null : (
        <p
          className="act__count"
          data-ledger-count
          data-ledger-more-matches={props.partial ? '' : undefined}
        >
          {`${String(props.passed)} of ${String(props.inView)} entries`}
          {props.partial ? '; more match than the search reads (500+)' : null}
        </p>
      )}
    </>
  );
}

/** Nothing passes: people and kinds filter only the days read, so older days may still match. */
export function NoMatch(props: {
  readonly earlier: boolean;
  readonly loading: boolean;
  readonly onClear: () => void;
  readonly onLoadEarlier: () => void;
}): ReactElement {
  return (
    <>
      <Empty
        title="Nothing matches that."
        description="This log holds every change to a task you can see: try a name on its own."
        onClearFilters={props.onClear}
      />
      {props.earlier ? (
        <button
          type="button"
          className="btn btn--secondary btn--sm act__more"
          disabled={props.loading}
          aria-busy={props.loading}
          onClick={props.onLoadEarlier}
        >
          Load earlier days
        </button>
      ) : null}
    </>
  );
}
