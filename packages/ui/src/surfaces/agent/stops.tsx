// SPDX-License-Identifier: AGPL-3.0-only
//
// A run stopped at its approved ceiling (AW-05). The token panel shows each
// run's latest stop, its count against three and, after the third, the one
// consolidated decision (MP-6-5); it writes nothing. A person answers the
// waiting ask below the panel (C54): a top-up in the ask's currency or one
// click that ends the work. The pane decides nothing itself: it hands the run
// the read showed to the caller, which sends `run.top_up` or
// `run.end_at_budget_stop`, and the four-eyes band is the server's.

import { useState, type ReactElement } from 'react';
import { STOP_LIMIT, type LedgerStop } from '../../state/token-ledger.ts';
import { minorOf, money } from './format.ts';

const count = (stop: LedgerStop): string => `Stop ${String(stop.number)} of ${String(STOP_LIMIT)}`;

const ANSWERED: Readonly<Record<string, string>> = {
  top_up: 'A person topped it up, and the run went back to work.',
  end: 'A person ended the work at this stop. The task stays open.',
};

/** One run's latest stop, as the panel shows it. */
function StopState(props: { readonly stop: LedgerStop }): ReactElement {
  const { stop } = props;
  return (
    <div
      className="tokrun"
      data-tokens="stop"
      data-stop-run={stop.runId}
      data-stop-kind={stop.kind}
      data-stop-answer={stop.answer ?? 'waiting'}
    >
      <span className="tokrun__model">{stop.runId}</span>
      <span className="tokrun__k" data-tokens="stop-count">
        {count(stop)}
      </span>
      <span className="tokrun__when">
        {`Stopped at its approved ceiling: ${money(stop.spentMinor, stop.currency)} of ${money(stop.ceilingMinor, stop.currency)} spent.`}
      </span>
      {stop.answer === null ? (
        <span className="tokrun__when" data-tokens="top-up-request">
          {stop.kind === 'consolidated' ? (
            <span data-tokens="consolidated">
              This is the one consolidated decision: top it up once more or end the work. It will
              not stop again to ask.
            </span>
          ) : (
            'The run waits and asks a person to top it up or end the work.'
          )}
        </span>
      ) : (
        <span className="tokrun__when">{ANSWERED[stop.answer] ?? stop.answer}</span>
      )}
      {stop.awaitingSecond === null ? null : (
        <span className="tokrun__when" data-tokens="awaiting-second">
          {`A top-up of ${money(stop.awaitingSecond.amountMinor, stop.currency)} waits for a second person.`}
        </span>
      )}
    </div>
  );
}

/** The panel's stops: each stopped run's latest ask. */
export function StopStates(props: { readonly stops: readonly LedgerStop[] }): ReactElement | null {
  if (props.stops.length === 0) return null;
  return (
    <div className="tokruns" data-tokens="stops">
      {props.stops.map((stop) => (
        <StopState key={stop.askId} stop={stop} />
      ))}
    </div>
  );
}

export interface StopAnswerProps {
  /** The latest ask of a run, still waiting for a person. */
  readonly stop: LedgerStop;
  readonly busy: boolean;
  /** The server's word that the top-up waits on a second person, or null. */
  readonly awaiting: string | null;
  readonly onTopUp: (runId: string, amountMinor: number, currency: string) => void;
  readonly onEnd: (runId: string) => void;
}

/** C54's answer at the stop: a top-up above nothing, in the ask's currency, or the end. */
export function StopAnswer(props: StopAnswerProps): ReactElement {
  const { stop } = props;
  const [amount, setAmount] = useState('');
  const minor = minorOf(amount);
  const ready = !props.busy && minor !== null && minor > 0;
  return (
    <div className="sb__sect" data-agent="budget-stop" data-stop-kind={stop.kind}>
      <StopHead stop={stop} />
      <Amount stop={stop} busy={props.busy} amount={amount} onAmount={setAmount} />
      {props.awaiting === null ? null : (
        <p className="card__sub" data-stop="awaiting">
          {props.awaiting}
        </p>
      )}
      <div className="btnrow">
        <button
          className="btn btn--sm"
          type="button"
          disabled={!ready}
          data-stop="top-up"
          onClick={() => {
            if (ready) props.onTopUp(stop.runId, minor, stop.currency);
          }}
        >
          Top up
        </button>
        <button
          className="btn btn--sm"
          type="button"
          disabled={props.busy}
          data-stop="end"
          onClick={() => {
            props.onEnd(stop.runId);
          }}
        >
          End the work
        </button>
      </div>
    </div>
  );
}

/** The top-up amount, as the person types it, in the ask's currency. */
function Amount(props: {
  readonly stop: LedgerStop;
  readonly busy: boolean;
  readonly amount: string;
  readonly onAmount: (amount: string) => void;
}): ReactElement {
  const id = `stop-amount-${props.stop.askId}`;
  return (
    <div className="field">
      <label className="tf__k" htmlFor={id}>
        Top up by ({props.stop.currency})
      </label>
      <input
        className="input"
        id={id}
        inputMode="decimal"
        disabled={props.busy}
        data-stop="amount"
        value={props.amount}
        onChange={(event) => {
          props.onAmount(event.target.value);
        }}
      />
    </div>
  );
}

/** What the answer is for: the stop's count and, on the third, the consolidated decision. */
function StopHead(props: { readonly stop: LedgerStop }): ReactElement {
  const consolidated = props.stop.kind === 'consolidated';
  return (
    <>
      <div className="sb__sh">
        <span className="sb__k">
          {consolidated ? 'The consolidated decision' : 'Stopped at its ceiling'}
        </span>
        <span className="sbact__meta">{count(props.stop)}</span>
      </div>
      <p className="card__sub">
        {consolidated
          ? 'The run has stopped three times. Top it up once more or end the work; it will not ask again.'
          : 'The run spent what was approved. Top it up so it carries on, or end the work.'}
      </p>
    </>
  );
}
