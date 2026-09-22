// SPDX-License-Identifier: AGPL-3.0-only
//
// `/sign-in`. An email, a password and which business to work in.
//
// The business selector is beside the credentials rather than after them
// because the address a person lands on is `/api/b/<key>/...` and they need to
// have chosen before the first call. Choosing the wrong one is not a security
// event: the server resolves the token's subject to a login in that business
// and refuses when there is none.

import { useState, type FormEvent, type ReactElement } from 'react';
import { FieldError } from '@launchastro/ui';
import { signIn } from '../session/sign-in.ts';
import type { Session } from '../session/token.ts';

export interface SignInProps {
  readonly gotrueUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly onSignedIn: (session: Session) => void;
}

const BUSINESSES: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'alpha', label: 'Alpha' },
  { key: 'bravo', label: 'Bravo' },
];

export function SignIn(props: SignInProps): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [businessKey, setBusinessKey] = useState('alpha');
  const [because, setBecause] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setBecause(null);
    setBusy(true);
    void (async () => {
      const result = await signIn({
        gotrueUrl: props.gotrueUrl,
        email,
        password,
        fetch: props.fetch,
      });
      setBusy(false);
      if (result.ok) props.onSignedIn({ token: result.token, businessKey, email });
      else setBecause(result.because);
    })();
  };

  return (
    <div className="signin">
      <form className="signin__form taskform" onSubmit={onSubmit}>
        <h2 className="tpr__title">Sign in</h2>
        <div className="field">
          <label className="tf__k" htmlFor="signin-email">
            Email
          </label>
          <input
            id="signin-email"
            className="input"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </div>
        <div className="field">
          <label className="tf__k" htmlFor="signin-password">
            Password
          </label>
          <input
            id="signin-password"
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </div>
        <div className="field">
          <label className="tf__k" htmlFor="signin-business">
            Business
          </label>
          <select
            id="signin-business"
            className="input"
            value={businessKey}
            onChange={(event) => {
              setBusinessKey(event.target.value);
            }}
          >
            {BUSINESSES.map((business) => (
              <option key={business.key} value={business.key}>
                {business.label}
              </option>
            ))}
          </select>
        </div>
        {because === null ? null : <FieldError controlId="signin-password" say={because} />}
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
