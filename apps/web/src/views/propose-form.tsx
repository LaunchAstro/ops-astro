// SPDX-License-Identifier: AGPL-3.0-only
//
// The propose form and the envelope's top-up (T2e) on a task page.
// `proposals.tsx` holds the section and says why the form keeps its draft and
// its refusal above the read.

import { useState, type FormEvent, type ReactElement } from 'react';
import type { OperationsClient } from '../operations/client.ts';
import type { TaskEnvelope } from '../../../../packages/core-wire/src/index.ts';
import { useCommand, type Settlement } from '../records/use-command.ts';
import { money } from './proposal-record.tsx';

interface ProposeProps {
  readonly client: OperationsClient;
  readonly recordId: string;
  readonly revision: number;
  /** An earlier refusal on this reader's authority, which outlives the reread. */
  readonly refusal: string | null;
  readonly onRefused: (because: string) => void;
  readonly draft: ProposeDraft | null;
  readonly onDraft: (next: ProposeDraft | null) => void;
  readonly onChanged: () => void;
  /**
   * The currency of the task's cap, as the task read carried it: the one
   * currency `task.decide` will approve a version in. Null when the business
   * has no cap, and absent from an answer that did not carry it.
   */
  readonly capCurrency: string | null | undefined;
}

/** An unsent proposal: the fields, the attempt whose outcome is unknown, and a stale refusal. */
export interface ProposeDraft {
  readonly purpose: string;
  readonly maximum: string;
  readonly pending: PendingProposal | null;
  /** The server's `VERSION_STALE`, quoted across the reread it caused. */
  readonly stale: string | null;
}

const EMPTY_PROPOSAL: ProposeDraft = {
  purpose: '',
  maximum: '',
  pending: null,
  stale: null,
};

/** A proposal whose outcome is not known, held so the retry is the same attempt. */
export interface PendingProposal {
  readonly operationId: string;
  /** The revision the attempt was sent at, resent with it so the register replays. */
  readonly revision: number;
  readonly purpose: string;
  readonly maximum: string;
  readonly currency: string;
}

export function Propose(props: ProposeProps): ReactElement {
  const current = props.draft ?? EMPTY_PROPOSAL;
  // `pending` is the attempt nobody knows the outcome of, as the board's create
  // keeps one (`Projects.tsx`). `task.propose` leaves the task's revision
  // alone, so the revision check cannot catch a retry; only the `operationId`
  // can.
  const { purpose, maximum, pending } = current;
  // The cap's currency and no other: a version in any other currency is one
  // `task.decide` refuses with `CAP_BINDING_MISMATCH`, so offering it would make
  // a proposal nobody can approve. With no cap there is nothing to offer.
  const currency = props.capCurrency ?? null;
  const put = (next: Partial<ProposeDraft>): void => {
    props.onDraft({ ...current, ...next });
  };
  const command = useCommand();
  const busy = command.busy;
  // The refusal is also held above the read, because a reread remounts this
  // form with a fresh command and the closure would otherwise be forgotten.
  const closed = command.closed || props.refusal !== null;
  const locked = busy || closed || currency === null;
  const because = command.because ?? props.refusal;
  const run = command.run;

  const same = (attempt: PendingProposal | null): attempt is PendingProposal =>
    attempt !== null &&
    attempt.purpose === purpose &&
    attempt.maximum === maximum &&
    attempt.currency === currency;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (locked || currency === null) return;
    const attempt = same(pending)
      ? pending
      : {
          operationId: props.client.newOperationId(),
          revision: props.revision,
          purpose,
          maximum,
          currency,
        };
    put({ pending: attempt, stale: null });
    run(
      () =>
        props.client.mutate(
          'task.propose',
          {
            recordId: props.recordId,
            purpose,
            // Money crosses the wire in minor units. The conversion happens once,
            // here, because three places that each convert are three places that
            // can disagree about what a dollar is.
            maximumMinor: minorOf(maximum),
            currency,
            payload: { step: purpose },
            // **`step` is an object, not the purpose again.** The contract is
            // `{ kind, payload }` (`commands/requests.ts`), and `proposeOnTask`
            // writes `step.kind` straight into `planned_steps.kind`, which is
            // `not null`. A bare string would put null in that column and the
            // handler would throw, which the API reports as a 503, so the screen
            // would say "the API answered 503" to a person whose proposal was
            // well formed. The browser case covers it, because a mounted
            // stand-in accepts anything.
            step: { kind: purpose, payload: { step: purpose } },
          },
          // The revision the attempt was made at: the page's for a new attempt,
          // the first send's for a retry. A proposal made against a task that has
          // moved on is the server's `VERSION_STALE`, not a silent write.
          { expectedRevision: attempt.revision, operationId: attempt.operationId },
        ),
      settledProposal,
    );
  };

  /**
   * What the server said about a proposal.
   *
   * A refusal about this reader's authority closes the form, because there is no
   * capability read to ask first and a control that has already been refused
   * should not keep inviting the same refusal. Anything else the person can
   * correct and send again. A success clears the form and reads the task, so the
   * version that appears is the server's rather than this form's own echo.
   */
  function settledProposal(settlement: Settlement): void {
    // An unknown outcome keeps the attempt; any answer from the server ends it.
    if (settlement.kind === 'unknown') return;
    if (settlement.kind === 'closed') props.onRefused(settlement.because);
    if (settlement.kind === 'stale') {
      // The task moved on. Keep the fields, read the task again, and say why.
      props.onDraft({ ...current, pending: null, stale: settlement.because });
      props.onChanged();
      return;
    }
    if (settlement.kind !== 'ok') {
      props.onDraft({ ...current, pending: null, stale: null });
      return;
    }
    props.onDraft(null);
    props.onChanged();
  }

  return (
    <form className="taskform" id="task-propose" onSubmit={submit}>
      <div className="sb__sh">
        <span className="sb__k">Propose something</span>
      </div>
      {because === null ? null : (
        <p className="field__error" role="alert" data-propose="refusal">
          {because}
        </p>
      )}
      {current.stale === null ? null : (
        <div role="alert" data-propose="stale">
          <p className="field__error">{current.stale}</p>
          <p className="card__sub">
            Somebody else moved this task on before your proposal was stored, so it was not. The
            task has been read again and your proposal is still here: propose it again if it still
            applies.
          </p>
        </div>
      )}
      <ProposeFields
        currency={currency}
        locked={locked}
        maximum={maximum}
        onPut={put}
        purpose={purpose}
      />
      <button className="btn btn--primary" data-propose="submit" disabled={locked} type="submit">
        {busy ? 'Proposing…' : 'Propose'}
      </button>
      {busy || !same(pending) ? null : (
        <p className="card__sub" data-propose="unresolved">
          This may already have been proposed. Proposing again sends the same attempt, so the server
          answers with the original result rather than opening a second proposal.
        </p>
      )}
      {!closed ? null : (
        <p className="card__sub" data-propose="closed">
          The server refused this. The form is closed rather than asking again on your behalf.
        </p>
      )}
    </form>
  );
}

/** The three fields a proposal names. The currency is the cap's, never a list of this form's. */
function ProposeFields(props: {
  readonly purpose: string;
  readonly maximum: string;
  readonly currency: string | null;
  readonly locked: boolean;
  readonly onPut: (next: Partial<ProposeDraft>) => void;
}): ReactElement {
  return (
    <>
      <div className="field">
        <label className="tf__k" htmlFor="propose-purpose">
          What it is for
        </label>
        {/*
        The pattern is the database's own
        (`proposal_versions_purpose_shape`, migration 0010), asked for here
        rather than discovered as a failure: a purpose with a dot or a capital
        in it violates that check inside the handler, and the API reports a
        violated check as a 503 rather than as a refusal a person could act
        on. Asking for the shape the column accepts is the difference between
        a form that tells you and a form that breaks.
      */}
        <input
          className="input"
          disabled={props.locked}
          id="propose-purpose"
          onChange={(event) => {
            props.onPut({ purpose: event.target.value });
          }}
          pattern="[a-z][a-z0-9_]{0,62}"
          required
          title="Lower case, digits and underscores, starting with a letter."
          type="text"
          value={props.purpose}
        />
        <p className="card__sub">
          Lower case, digits and underscores, such as client_renewal_quote.
        </p>
      </div>
      <div className="field">
        <label className="tf__k" htmlFor="propose-maximum">
          The most it may spend
        </label>
        <input
          className="input"
          disabled={props.locked}
          id="propose-maximum"
          min="0"
          onChange={(event) => {
            props.onPut({ maximum: event.target.value });
          }}
          required
          step="0.01"
          type="number"
          value={props.maximum}
        />
      </div>
      <div className="field">
        <label className="tf__k" htmlFor="propose-currency">
          In
        </label>
        <select
          className="input"
          disabled={props.locked}
          id="propose-currency"
          onChange={() => undefined}
          value={props.currency ?? ''}
        >
          {props.currency === null ? null : (
            <option value={props.currency}>{props.currency}</option>
          )}
        </select>
        {props.currency !== null ? null : (
          <p className="card__sub" data-propose="no-cap">
            This task has no budget cap to draw on, so there is no currency a proposal could be
            approved in.
          </p>
        )}
      </div>
    </>
  );
}

/** Dollars as the server's minor units, rounded rather than truncated. */
function minorOf(amount: string): number {
  return Math.round(Number(amount) * 100);
}

/** The envelope and its top-up (T2e), of the maximum drawn here so a moved envelope is refused. */
/** A first approval waiting on a second person, or a refusal as the server said it. */
export interface TopUpNote {
  readonly kind: 'awaiting' | 'refusal';
  readonly said: string;
}

const AWAITING =
  'Your approval is recorded. Above the four-eyes threshold a second person approves it too.';

export function TopUp(props: {
  readonly client: OperationsClient;
  readonly envelope: TaskEnvelope;
  readonly recordId: string;
  readonly note: TopUpNote | null;
  readonly onNote: (note: TopUpNote | null) => void;
  readonly onChanged: () => void;
}): ReactElement {
  const { envelope, note } = props;
  const command = useCommand();
  const [amount, setAmount] = useState('');
  const submit = (): void => {
    if (command.locked || minorOf(amount) <= 0) return;
    command.run(
      () =>
        props.client.mutate('budget.top_up', {
          recordId: props.recordId,
          amountMinor: minorOf(amount),
          fromMaximumMinor: envelope.maximumMinor,
        }),
      (settlement) => {
        // Held above the read: the reread below unmounts this control.
        if (settlement.kind !== 'ok') props.onNote({ kind: 'refusal', said: settlement.because });
        else if (settlement.value.detail?.['state'] === 'awaiting_second_approver') {
          props.onNote({ kind: 'awaiting', said: AWAITING });
        } else props.onNote(null);
        if (settlement.kind === 'ok') setAmount('');
        props.onChanged();
      },
    );
  };
  return (
    <div className="sbact" data-top-up="section">
      <div className="sb__sh">
        <span className="sb__k">Budget for this task</span>
      </div>
      <p className="card__sub" data-top-up="envelope">
        approved {money(envelope.maximumMinor, envelope.currency)} · held{' '}
        {money(envelope.heldMinor, '')} · spent {money(envelope.actualMinor, '')}
      </p>
      {note === null ? null : (
        <p
          className={note.kind === 'refusal' ? 'field__error' : 'card__sub'}
          data-top-up={note.kind}
          {...(note.kind === 'refusal' ? { role: 'alert' } : {})}
        >
          {note.said}
        </p>
      )}
      <div className="field">
        <label className="tf__k" htmlFor="top-up-amount">
          Top up by ({envelope.currency})
        </label>
        <input
          className="input"
          disabled={command.locked}
          id="top-up-amount"
          min="0"
          step="0.01"
          type="number"
          onChange={(event) => {
            setAmount(event.target.value);
          }}
          value={amount}
        />
      </div>
      <div className="btnrow">
        <button
          className="btn"
          data-top-up="submit"
          disabled={command.locked}
          onClick={submit}
          type="button"
        >
          {command.busy ? 'Approving…' : 'Approve top-up'}
        </button>
      </div>
    </div>
  );
}
