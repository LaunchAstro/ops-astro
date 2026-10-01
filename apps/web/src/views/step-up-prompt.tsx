// SPDX-License-Identifier: AGPL-3.0-only
//
// The one money step-up prompt (C59), drawn wherever a money write was refused
// `STEP_UP_REQUIRED`: the planning cap and the top-up at a budget stop. The
// kit's banner, field and buttons; a refused code is the server's own words.

import { useId, useState, type ReactElement } from 'react';
import type { StepUpAsk } from '../records/use-money-command.ts';

const SIX_DIGITS = /^\d{6}$/u;

/** The six-digit field, which a phone fills from the authenticator app. */
export function CodeField(props: {
  readonly code: string;
  readonly onCode: (code: string) => void;
  readonly ask: Pick<StepUpAsk, 'because' | 'checking'>;
}): ReactElement {
  const id = useId();
  const { because, checking } = props.ask;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        Authenticator code
      </label>
      <input
        id={id}
        className="tf"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        data-step-up="code"
        value={props.code}
        disabled={checking}
        aria-invalid={because === null ? undefined : true}
        aria-describedby={because === null ? undefined : `${id}-error`}
        onChange={(event) => {
          props.onCode(event.target.value);
        }}
      />
      {because === null ? null : (
        <p className="field__error" id={`${id}-error`} role="alert">
          {because}
        </p>
      )}
    </div>
  );
}

export function StepUpPrompt(props: { readonly ask: StepUpAsk }): ReactElement {
  const { ask } = props;
  const [code, setCode] = useState('');
  const ready = SIX_DIGITS.test(code) && !ask.checking;
  return (
    <form
      className="banner"
      data-step-up="prompt"
      aria-label="Confirm with your authenticator app"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) ask.submit(code);
      }}
    >
      <div className="banner__body stack">
        <p className="card__sub">
          Money changes need your authenticator code within the last hour. Enter the six digits it
          shows now and this change is sent again.
        </p>
        <CodeField code={code} onCode={setCode} ask={ask} />
        <div className="btnrow">
          <button
            className="btn btn--primary"
            type="submit"
            data-step-up="confirm"
            disabled={!ready}
          >
            {ask.checking ? 'Checking…' : 'Confirm and send'}
          </button>
          <button
            className="btn btn--ghost"
            type="button"
            data-step-up="cancel"
            onClick={ask.cancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}
