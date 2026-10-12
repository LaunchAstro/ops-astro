// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings/password/`: change your own password while signed in (`session/password-change.ts`,
// through the application's `PasswordChangeContext`). The current password, the new one twice,
// and, for a login with an authenticator app, its code once the change asks for it. A new
// password of 12 to 72 bytes, the bounds the reset holds (C40), is checked here before
// anything is sent. Once changed, the fields empty and the page says whether the person's other
// sessions were signed out. It is drawn with the kit's card and fields, so it adds no look of its own.

import { useContext, useState, type FormEvent, type ReactElement } from 'react';
import { FieldError } from '@launchastro/ui';
import { PasswordChangeContext, type PasswordChange } from '../../session/password-change.ts';
import { CodeField } from '../../views/step-up-prompt.tsx';

const BYTES = { least: 12, most: 72 } as const;

const CHANGED = 'Your password is changed. Your other sessions are signed out.';
const CHANGED_OTHERS_OPEN =
  'Your password is changed. Your other sessions could not all be signed out: use Sign out other sessions in Settings.';

/** Why the new password cannot be sent, or null when it can. */
function refusedHere(next: string, repeat: string): string | null {
  const bytes = new TextEncoder().encode(next).length;
  if (bytes < BYTES.least || bytes > BYTES.most) {
    return `Choose a new password of ${String(BYTES.least)} to ${String(BYTES.most)} characters.`;
  }
  return next === repeat ? null : 'The two new passwords do not match.';
}

function PasswordInput(props: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onValue: (value: string) => void;
  readonly fresh?: boolean;
}): ReactElement {
  return (
    <div className="field">
      <label className="field__label" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        className="tf"
        type="password"
        autoComplete={props.fresh === true ? 'new-password' : 'current-password'}
        required
        value={props.value}
        onChange={(event) => {
          props.onValue(event.target.value);
        }}
      />
    </div>
  );
}

function usePasswordForm() {
  const change = useContext(PasswordChangeContext);
  const [fields, setFields] = useState({ current: '', next: '', repeat: '', code: '' });
  const [asksCode, setAsksCode] = useState(false);
  const [because, setBecause] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (name: keyof typeof fields) => (value: string) => {
    setFields((held) => ({ ...held, [name]: value }));
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setOutcome(null);
    const refused = change === null ? 'Sign in first.' : refusedHere(fields.next, fields.repeat);
    setBecause(refused);
    if (refused !== null || change === null) return;
    const asked: PasswordChange = {
      currentPassword: fields.current,
      newPassword: fields.next,
      ...(asksCode ? { code: fields.code } : {}),
    };
    setBusy(true);
    void (async () => {
      const result = await change(asked);
      setBusy(false);
      if (result.ok) {
        setFields({ current: '', next: '', repeat: '', code: '' });
        setAsksCode(false);
        setOutcome(result.othersEnded ? CHANGED : CHANGED_OTHERS_OPEN);
        return;
      }
      if (result.needsCode === true) setAsksCode(true);
      setFields((held) => ({ ...held, code: '' }));
      setBecause(result.needsCode === true ? null : result.because);
    })();
  };
  return { fields, set, asksCode, because, outcome, busy, submit };
}

/** The three password fields, and the code once the change asks for it. */
function Fields(props: { readonly form: ReturnType<typeof usePasswordForm> }): ReactElement {
  const { fields, set, asksCode, busy } = props.form;
  return (
    <>
      <PasswordInput
        id="password-current"
        label="Current password"
        value={fields.current}
        onValue={set('current')}
      />
      <PasswordInput
        id="password-new"
        label="New password"
        value={fields.next}
        onValue={set('next')}
        fresh
      />
      <PasswordInput
        id="password-repeat"
        label="New password again"
        value={fields.repeat}
        onValue={set('repeat')}
        fresh
      />
      {asksCode ? (
        <>
          <p className="card__sub" data-password="code">
            Enter the six-digit code from your authenticator app to change your password.
          </p>
          <CodeField
            code={fields.code}
            onCode={set('code')}
            ask={{ because: null, checking: busy }}
          />
        </>
      ) : null}
    </>
  );
}

export function PasswordChangeScreen(): ReactElement {
  const form = usePasswordForm();
  const { because, busy } = form;
  return (
    <section className="sec" data-screen="password">
      <form
        className="card"
        aria-labelledby="password-title"
        data-password="form"
        onSubmit={form.submit}
      >
        <h1 className="card__title" id="password-title">
          Change your password
        </h1>
        {form.outcome === null ? null : (
          <p className="card__sub" role="status" data-password="outcome">
            {form.outcome}
          </p>
        )}
        <Fields form={form} />
        {because === null ? null : (
          <div role="alert">
            <FieldError controlId="password-new" say={because} />
          </div>
        )}
        <div className="btnrow">
          <button className="btn btn--primary" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </section>
  );
}
