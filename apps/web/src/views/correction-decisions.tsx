// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 (P30): the correction card's Launch control, moved whole from
// `correction-card.tsx` for its line cap. A person's Launch and Decline,
// through `live_correction.decide`; Launch only while the version's check
// holds. #1781 adds the business's single-operator mode beside it, and a
// Launch the server refused for a missing Astra review stays drawn but
// disabled, with that reason, while the card shows the same version: no read
// says the review was recorded since, so a reread, a failed read or a list
// read keeps it, and a new version or a fresh drawer drops it. The server
// stays the control.

import type { ReactElement } from 'react';
import { refusalWords } from '../assistant/correction.ts';
import type { Correction } from '../assistant/correction-desks.ts';

const DECISIONS = [
  // The owner's word for this flow (#1612); the server's decision stays `approve`.
  ['approve', 'Launch'],
  ['reject', 'Decline'],
] as const;

const MODE_WORDS = {
  on: 'Single-operator mode is on: the business’s one operator may Launch a change they asked for.',
  off: 'Single-operator mode is off: someone other than the person who asked Launches a change.',
} as const;

/** A person's approve and decline, the card's only controls; approve only while the check holds. */
export function Decisions(props: {
  readonly busy: boolean;
  readonly launchable: boolean;
  /** Launch was refused for a missing Astra review of this version: drawn, not pressable. */
  readonly held: boolean;
  /** The business's single-operator mode, or null where it was not read. */
  readonly singleOperator: boolean | null;
  readonly onDecide: (decision: 'approve' | 'reject') => void;
}): ReactElement {
  const offered = DECISIONS.filter(([decision]) => decision !== 'approve' || props.launchable);
  return (
    <>
      {props.singleOperator === null ? null : (
        <p className="aip__plan-meta" data-correction-single-operator="">
          {MODE_WORDS[props.singleOperator ? 'on' : 'off']}
        </p>
      )}
      <div className="aip__plan-act">
        {offered.map(([decision, words]) => (
          <button
            key={decision}
            type="button"
            className={decision === 'approve' ? 'btn btn--primary btn--sm' : 'btn btn--sm'}
            data-correction-decide={decision}
            disabled={props.busy || (decision === 'approve' && props.held)}
            onClick={() => {
              props.onDecide(decision);
            }}
          >
            {words}
          </button>
        ))}
      </div>
    </>
  );
}

/** Launch is held: the server refused it for a missing Astra review of the version shown. */
export const reviewHeld = (correction: Correction): boolean =>
  correction.reviewMissingFor !== null && correction.reviewMissingFor === correction.versionId;

const HELD_WORDS = refusalWords('ASTRA_REVIEW_MISSING');

/** The card's notes: the page being checked again, why Launch is held, and the last refusal. */
export function Notes(props: {
  readonly checking: boolean;
  readonly correction: Correction;
}): ReactElement {
  const held = reviewHeld(props.correction);
  // The hold's reason is drawn once, beside a later refusal that says something else.
  const { refusal } = props.correction;
  const other = refusal === null || (held && refusal === HELD_WORDS) ? null : refusal;
  return (
    <>
      {props.checking ? (
        <p className="aip__plan-meta" data-correction-checking="">
          Checking the page again…
        </p>
      ) : null}
      {held ? (
        <p className="aip__plan-meta aip__plan-refused" role="alert" data-correction-launch-held="">
          {HELD_WORDS}
        </p>
      ) : null}
      {other === null ? null : (
        <p className="aip__plan-meta aip__plan-refused" role="alert">
          {other}
        </p>
      )}
    </>
  );
}
