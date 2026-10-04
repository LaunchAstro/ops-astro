// SPDX-License-Identifier: AGPL-3.0-only
//
// The two ways the authenticator panel changes course (C59, Q2): removing the
// app with the current code from it, which a person needs before setting up a
// new one, and signing in again with the password, which a set-up refused
// `FRESH_SIGN_IN_REQUIRED` asks for.
//
// The removal is the person's own account route with the code alone; the
// server checks it with the provider and ends the person's other sessions.
// The sign-in again is the application's (`SignInAgainContext`,
// `session/sign-in-again.ts`): the password goes to the provider, the tab moves
// to the new sign-in and the old one is signed out. The password is cleared
// from the field as it is sent and kept nowhere.

import { useContext, useEffect, useRef, useState, type ReactElement } from 'react';
import { Button } from '@launchastro/ui';
import type { OperationsClient } from '../../operations/client.ts';
import { describeFailure } from '../../records/submit.ts';
import { SignInAgainContext } from '../../records/use-money-command.ts';
import { CodeField, PasswordField } from '../../views/step-up-prompt.tsx';

export const SIX_DIGITS = /^\d{6}$/u;

type Checked = { readonly ok: true } | { readonly ok: false; readonly because: string };

/** One check in flight, its words when it fails, and nothing drawn once the form is gone. */
export function useCheck(onDone: () => void) {
  const [checking, setChecking] = useState(false);
  const [because, setBecause] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const check = (attempt: () => Promise<Checked>): void => {
    setChecking(true);
    setBecause(null);
    void (async () => {
      const result = await attempt();
      if (!alive.current) return;
      setChecking(false);
      if (result.ok) onDone();
      else setBecause(result.because);
    })();
  };
  return { checking, because, check };
}

/** The form's confirm, found by `confirm`, and its cancel. */
export function Buttons(props: {
  readonly confirm: string;
  readonly label: string;
  readonly ready: boolean;
  readonly checking: boolean;
  readonly onCancel: () => void;
}): ReactElement {
  return (
    <div className="btnrow">
      <span data-factor={props.confirm}>
        <Button
          variant="primary"
          type="submit"
          disabled={!props.ready}
          busy={props.checking ? 'Checking…' : undefined}
        >
          {props.label}
        </Button>
      </span>
      <span data-factor="cancel">
        <Button variant="ghost" disabled={props.checking} onClick={props.onCancel}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

/**
 * Once signed in again, the set-up starts again on the client built for the new
 * sign-in: at once if it is already here, or when it lands, in the same business.
 */
export function useRestart(client: OperationsClient, start: () => void) {
  const latest = useRef({ client, start });
  latest.current = { client, start };
  const waiting = useRef<OperationsClient | null>(null);
  useEffect(() => {
    const from = waiting.current;
    if (from === null || client === from) return;
    waiting.current = null;
    if (client.businessKey === from.businessKey) latest.current.start();
  }, [client]);
  return (from: OperationsClient) => {
    if (latest.current.client === from) waiting.current = from;
    else if (latest.current.client.businessKey === from.businessKey) latest.current.start();
  };
}

/** The current code from the app, for removing it. */
export function RemoveForm(props: {
  readonly client: OperationsClient;
  readonly onRemoved: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const [code, setCode] = useState('');
  const { checking, because, check } = useCheck(props.onRemoved);
  const ready = SIX_DIGITS.test(code) && !checking;
  return (
    <form
      className="stack"
      aria-label="Remove your authenticator app"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        check(async () => {
          const result = await props.client.removeFactor(code);
          if ('ok' in result) return { ok: true };
          return { ok: false, because: describeFailure(result) ?? 'The removal was not made.' };
        });
      }}
    >
      <p className="card__sub">
        Enter the code your authenticator app shows now. Your other sessions are signed out.
      </p>
      <CodeField
        code={code}
        onCode={setCode}
        ask={{ because, checking }}
        marker={{ 'data-factor': 'remove-code' }}
      />
      <Buttons
        confirm="remove-confirm"
        label="Remove authenticator app"
        ready={ready}
        checking={checking}
        onCancel={props.onCancel}
      />
    </form>
  );
}

/** The password, for the fresh sign-in a set-up asks for. */
export function SignInAgainForm(props: {
  readonly onSignedIn: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const signInAgain = useContext(SignInAgainContext);
  const [password, setPassword] = useState('');
  const { checking, because, check } = useCheck(props.onSignedIn);
  const ready = signInAgain !== null && password !== '' && !checking;
  return (
    <form
      className="stack"
      aria-label="Sign in again"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        const typed = password;
        setPassword('');
        check(async () => await signInAgain(typed));
      }}
    >
      <PasswordField
        password={password}
        onPassword={setPassword}
        ask={{ because, checking }}
        marker={{ 'data-factor': 'password' }}
      />
      <Buttons
        confirm="sign-in"
        label="Sign in again"
        ready={ready}
        checking={checking}
        onCancel={props.onCancel}
      />
    </form>
  );
}
