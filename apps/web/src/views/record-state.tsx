// SPDX-License-Identifier: AGPL-3.0-only
//
// The five renderings of a read, and the rule that binds them: **a read that
// did not succeed draws no data at all.**
//
// The corpus names six read outcomes — loading, no-run, denied, unavailable,
// stale and ready. Five of them are states of *this* read and are rendered
// here. `stale` is not: it is a statement about a value that did arrive, so it
// belongs to the surface drawing that value, and a read cannot be both
// unresolved and stale. `no-run` is the corpus's name for the sixth case this
// module calls `empty` — an authorised collection with no rows — and the two
// are the same fact under two names, so it is drawn once.
//
// **Why `denied` and `empty` are different components and not one with a flag.**
// A denied read and an authorised empty collection look identical if you only
// have the rows: both have none. Converging them is the legacy behaviour the
// acceptance checklist singles out — "list/detail renders denied, never
// empty-success" (N2) — and the only way a person can tell them apart is if
// the product decided to tell them. So the denied rendering states the server's
// own code, and the empty rendering says the collection is empty and does not
// apologise for it.
//
// **Nothing here has a fallback to sample data** (B7). There is no `?? []` in
// this file and there must not be one: an empty array in place of a failed
// read is a success-looking lie, and it is the exact failure the honest-failure
// case exists to catch.

import type { ReactElement, ReactNode } from 'react';
import { Empty } from '@launchastro/ui';
import type { ReadState } from '../data/authorised-read.ts';
import { describeRefusal } from '../records/submit.ts';

export interface RecordStateProps<T> {
  readonly state: ReadState<T>;
  /** What this read is of, in words, for the absence copy. "task", "board". */
  readonly subject: string;
  /** Drawn only when the read succeeded with rows. */
  readonly children: (value: T) => ReactNode;
  /** Drawn instead of the default empty voice, when a surface has a better one. */
  readonly empty?: ReactNode;
  /** Offered on the failures a person can do something about. */
  readonly onRetry?: () => void;
}

export function RecordState<T>(props: RecordStateProps<T>): ReactElement {
  const state = props.state;

  if (state.outcome === 'loading') {
    return (
      <div className="readstate" data-outcome="loading" role="status" aria-live="polite">
        <p className="empty__title">Loading the {props.subject}…</p>
      </div>
    );
  }

  if (state.outcome === 'denied') {
    // The server's code, verbatim. Not "something went wrong", and not a
    // friendlier word chosen by this file: a refusal a person cannot quote is
    // a refusal they cannot get help with.
    return (
      <div className="readstate" data-outcome="denied" role="alert">
        <Empty
          title={`You are not permitted to see this ${props.subject}.`}
          description={describeRefusal(state.refusal)}
          hint="This is a decision the server made. It is not an error and the list is not empty."
        />
      </div>
    );
  }

  if (state.outcome === 'unavailable') {
    return (
      <div className="readstate" data-outcome="unavailable" role="alert">
        <Empty
          title={`The ${props.subject} could not be read.`}
          description={state.because}
          hint="Nothing has been decided about your access. Try again."
          action={
            props.onRetry === undefined ? undefined : (
              <button className="btn" type="button" onClick={props.onRetry}>
                Try again
              </button>
            )
          }
        />
      </div>
    );
  }

  if (state.outcome === 'empty') {
    return (
      <div className="readstate" data-outcome="empty">
        {props.empty ?? (
          <Empty title={`No ${props.subject} yet.`} description="Nothing has been added to it." />
        )}
      </div>
    );
  }

  return (
    <div className="readstate" data-outcome="ready">
      {props.children(state.value)}
    </div>
  );
}
