// SPDX-License-Identifier: AGPL-3.0-only
//
// The one money step-up prompt (C59), drawn wherever a money write was refused
// `STEP_UP_REQUIRED`: the planning cap and the top-up at a budget stop. The
// kit's banner, field and buttons; a refused code is the server's own words.
// A client's refusal names `sign_in`, and the prompt asks for their password
// instead (Q1); a refused password is the provider's own words. The password
// is cleared from the field as it is sent.

import { useId, useState, type InputHTMLAttributes, type ReactElement } from 'react';
import type { StepUpAsk } from '../records/use-money-command.ts';

const SIX_DIGITS = /^\d{6}$/u;

type Marker = Readonly<Partial<Record<'data-step-up' | 'data-factor', string>>>;

interface FieldProps {
  readonly ask: Pick<StepUpAsk, 'because' | 'checking'>;
  /** What tests and the visual harness find the input by. */
  readonly marker?: Marker;
}

/** One labelled input, its refusal under it in the words it came in. */
function Field(
  props: FieldProps & {
    readonly label: string;
    readonly input: InputHTMLAttributes<HTMLInputElement>;
    readonly value: string;
    readonly onValue: (value: string) => void;
  },
): ReactElement {
  const id = useId();
  const { because, checking } = props.ask;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {props.label}
      </label>
      <input
        id={id}
        className="tf"
        {...props.input}
        {...props.marker}
        value={props.value}
        disabled={checking}
        aria-invalid={because === null ? undefined : true}
        aria-describedby={because === null ? undefined : `${id}-error`}
        onChange={(event) => {
          props.onValue(event.target.value);
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

const CODE_INPUT = {
  type: 'text',
  inputMode: 'numeric',
  autoComplete: 'one-time-code',
  maxLength: 6,
} as const;

/** The six-digit field, which a phone fills from the authenticator app. */
export function CodeField(
  props: FieldProps & { readonly code: string; readonly onCode: (code: string) => void },
): ReactElement {
  return (
    <Field
      ask={props.ask}
      marker={props.marker ?? { 'data-step-up': 'code' }}
      label="Authenticator code"
      input={CODE_INPUT}
      value={props.code}
      onValue={props.onCode}
    />
  );
}

const PASSWORD_INPUT = { type: 'password', autoComplete: 'current-password' } as const;

/** The person's password, for a sign-in again; the browser may fill it. */
export function PasswordField(
  props: FieldProps & { readonly password: string; readonly onPassword: (typed: string) => void },
): ReactElement {
  return (
    <Field
      ask={props.ask}
      marker={props.marker ?? { 'data-step-up': 'password' }}
      label="Password"
      input={PASSWORD_INPUT}
      value={props.password}
      onValue={props.onPassword}
    />
  );
}

/** The words and the field for whichever way the prompt is met. */
function Way(props: {
  readonly ask: StepUpAsk;
  readonly typed: string;
  readonly onTyped: (typed: string) => void;
}): ReactElement {
  const { ask, typed, onTyped } = props;
  if (ask.way === 'password') {
    return (
      <>
        <p className="card__sub">
          Money changes need a sign-in within the last hour. Enter your password and this change is
          sent again.
        </p>
        <PasswordField password={typed} onPassword={onTyped} ask={ask} />
      </>
    );
  }
  return (
    <>
      <p className="card__sub">
        Money changes need your authenticator code within the last hour. Enter the six digits it
        shows now and this change is sent again.
      </p>
      <CodeField code={typed} onCode={onTyped} ask={ask} />
    </>
  );
}

export function StepUpPrompt(props: { readonly ask: StepUpAsk }): ReactElement {
  const { ask } = props;
  const [typed, setTyped] = useState('');
  const byPassword = ask.way === 'password';
  const ready = (byPassword ? typed !== '' : SIX_DIGITS.test(typed)) && !ask.checking;
  const label = byPassword ? 'Sign in again and send' : 'Confirm and send';
  return (
    <form
      className="banner"
      data-step-up="prompt"
      aria-label={byPassword ? 'Sign in again' : 'Confirm with your authenticator app'}
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        if (!byPassword) {
          ask.submit(typed);
          return;
        }
        // The password leaves the field as it is sent.
        setTyped('');
        ask.submitPassword(typed);
      }}
    >
      <div className="banner__body stack">
        <Way ask={ask} typed={typed} onTyped={setTyped} />
        <div className="btnrow">
          <button
            className="btn btn--primary"
            type="submit"
            data-step-up="confirm"
            disabled={!ready}
          >
            {ask.checking ? 'Checking…' : label}
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
