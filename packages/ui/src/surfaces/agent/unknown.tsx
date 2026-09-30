// SPDX-License-Identifier: AGPL-3.0-only
//
// C54 on the Agent pane: a person's word on an unknown effect. The newest
// attempt is held with its effect unknown, so the run stays stopped until a
// person records one of the three decided outcomes, or writes the liability
// off at an amount with a written reason. An effect not yet known keeps its
// stop: there is no fourth outcome to press. The pane decides nothing itself;
// it hands the attempt the read showed to the caller, which sends it through
// `budget.record_outcome` or `budget.write_off`.

import { useState, type ReactElement } from 'react';
import type { RunStory } from '../../state/agent-run.ts';
import { minorOf } from './format.ts';

export type RecordedOutcome = 'nothing_happened' | 'happened' | 'happened_differently';

const OUTCOMES: readonly {
  readonly outcome: RecordedOutcome;
  readonly label: string;
  readonly after: string;
}[] = [
  { outcome: 'nothing_happened', label: 'Nothing happened', after: 'The work resumes.' },
  {
    outcome: 'happened',
    label: 'It happened',
    after: 'The run finishes with the effect recorded.',
  },
  {
    outcome: 'happened_differently',
    label: 'It happened differently',
    after: 'The work reopens.',
  },
];

export interface UnknownOutcomeProps {
  readonly story: RunStory;
  readonly busy: boolean;
  /** The server's word that a write-off waits on a second person, or null. */
  readonly awaiting: string | null;
  readonly onOutcome: (attemptId: string, outcome: RecordedOutcome) => void;
  readonly onWriteOff: (attemptId: string, amountMinor: number, reason: string) => void;
}

export function UnknownOutcome(props: UnknownOutcomeProps): ReactElement | null {
  const unknown = props.story.unknownAttempt;
  if (unknown === null) return null;
  return (
    <div className="sb__sect" data-agent="unknown-outcome">
      <div className="sb__sh">
        <span className="sb__k">What happened?</span>
      </div>
      <p className="card__sub" data-agent="unknown">
        The worker was lost after the provider may have acted. The run stays stopped until a person
        says what happened.
      </p>
      <div className="btnrow">
        {OUTCOMES.map((each) => (
          <button
            key={each.outcome}
            className="btn btn--sm"
            type="button"
            disabled={props.busy}
            data-outcome={each.outcome}
            title={each.after}
            onClick={() => {
              props.onOutcome(unknown.id, each.outcome);
            }}
          >
            {each.label}
          </button>
        ))}
      </div>
      <WriteOff {...props} attemptId={unknown.id} heldMinor={unknown.heldMinor} />
    </div>
  );
}

/** The write-off: an amount to charge (the hold, a lesser figure, or 0) and a written reason. */
function WriteOff(
  props: UnknownOutcomeProps & { readonly attemptId: string; readonly heldMinor: number },
): ReactElement {
  const [amount, setAmount] = useState((props.heldMinor / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const charge = minorOf(amount);
  const ready = !props.busy && charge !== null && reason.trim() !== '';
  return (
    <div className="sbact" data-agent="write-off">
      <Fields
        busy={props.busy}
        currency={props.story.head.currency}
        amount={amount}
        reason={reason}
        onAmount={setAmount}
        onReason={setReason}
      />
      {props.awaiting === null ? null : (
        <p className="card__sub" data-write-off="awaiting">
          {props.awaiting}
        </p>
      )}
      <button
        className="btn btn--sm"
        type="button"
        disabled={!ready}
        data-write-off="submit"
        onClick={() => {
          if (ready) props.onWriteOff(props.attemptId, charge, reason.trim());
        }}
      >
        Write off
      </button>
    </div>
  );
}

/** The amount to charge and the written reason, as the person types them. */
function Fields(props: {
  readonly busy: boolean;
  readonly currency: string;
  readonly amount: string;
  readonly reason: string;
  readonly onAmount: (amount: string) => void;
  readonly onReason: (reason: string) => void;
}): ReactElement {
  return (
    <>
      <div className="field">
        <label className="tf__k" htmlFor="write-off-amount">
          Write off, charging ({props.currency})
        </label>
        <input
          className="input"
          id="write-off-amount"
          inputMode="decimal"
          disabled={props.busy}
          data-write-off="amount"
          value={props.amount}
          onChange={(event) => {
            props.onAmount(event.target.value);
          }}
        />
      </div>
      <div className="field">
        <label className="tf__k" htmlFor="write-off-reason">
          Why
        </label>
        <textarea
          className="input"
          id="write-off-reason"
          disabled={props.busy}
          data-write-off="reason"
          value={props.reason}
          onChange={(event) => {
            props.onReason(event.target.value);
          }}
        />
      </div>
    </>
  );
}
