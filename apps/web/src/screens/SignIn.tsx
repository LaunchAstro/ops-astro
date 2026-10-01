// SPDX-License-Identifier: AGPL-3.0-only
//
// `/sign-in`. An email, a password and which business to work in.
//
// The business selector is beside the credentials rather than after them
// because the address a person lands on is `/api/b/<key>/...` and they need to
// have chosen before the first call. Choosing the wrong one is not a security
// event: the server resolves the token's subject to a login in that business
// and refuses when there is none.
//
// **The form comes back offering the business the person was interrupted in.**
// A task address is business-local, so sign-in defaulting to `alpha` after an
// interruption in Bravo is an invitation to reopen the wrong record.
//
// **The notice above the form prints the server's code.** The API refuses a
// bearer it will not act on with a 401 on one of two codes
// (`docs/local/WEB.md`, "When the session ends"): `AUTH_SESSION_EXPIRED` for a
// bearer whose signature verifies and whose `exp` has passed, and
// `AUTH_UNKNOWN_LOGIN` for a missing, forged, unsigned or subject-less one. Both
// end the session the same way, so the notice says what holds for both: the
// session has ended, this is the word the server used, and anything unsaved is
// gone. The code is printed because a refusal a person cannot quote is a refusal
// they cannot get help with -- the same rule the read states follow.
//
// **A failed sign-in is paired with the password control and announced.** The
// control carries `aria-invalid` and points at the message with
// `aria-describedby`, the pairing `FieldError` documents, and the message sits
// in an alert region so a screen reader hears it when it appears.

import { useState, type FormEvent, type ReactElement } from 'react';
import { BrandMark, FieldError } from '@launchastro/ui';
import { openSession } from '../session/sign-in.ts';
import type { Interruption, Session } from '../session/token.ts';

export interface SignInProps {
  readonly gotrueUrl: string;
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
  readonly onSignedIn: (session: Session) => void;
  /** Set when the person was put here by a session that ended under them. */
  readonly ended: Interruption | null;
  /** The version stamp, drawn where the rail would draw it; null for an unstamped build. */
  readonly build?: string | null;
}

const BUSINESSES: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'alpha', label: 'Alpha' },
  { key: 'bravo', label: 'Bravo' },
];

export function SignIn(props: SignInProps): ReactElement {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // The business the interruption was in, when there was one: the form asks
  // again for where the person was working, not for the first entry in the
  // list. They may still choose another one, and App says so when they do.
  const [businessKey, setBusinessKey] = useState(props.ended?.businessKey ?? 'alpha');
  const [because, setBecause] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setBecause(null);
    setBusy(true);
    void (async () => {
      const result = await openSession({
        gotrueUrl: props.gotrueUrl,
        apiOrigin: props.apiOrigin,
        email,
        password,
        fetch: props.fetch,
      });
      setBusy(false);
      if (result.ok)
        props.onSignedIn({
          businessKey,
          email,
          ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
        });
      else setBecause(result.because);
    })();
  };

  // Signed out there is no shell: the rail's pages all ask for a session, so
  // the page is the brand mark and the form, held to the kit (B6).
  return (
    <main className="signin" data-screen="sign-in">
      <form className="signin__form card" aria-labelledby="signin-title" onSubmit={onSubmit}>
        <div className="signin__brand">
          <BrandMark variant="wordmark" />
          <span className="rail__hub">Ops Astro</span>
        </div>
        <h1 className="card__title" id="signin-title">
          Sign in
        </h1>
        {props.ended === null ? null : (
          <div className="banner banner--warn" role="status" data-reason="session-ended">
            <p className="banner__body">
              Your session has ended and you need to sign in again. The server answered{' '}
              <code>{props.ended.code}</code>. Any edit you had not saved was not saved, and signing
              in to <strong>{props.ended.businessKey}</strong> will take you back to where you were.
            </p>
          </div>
        )}
        <div className="field">
          <label className="field__label" htmlFor="signin-email">
            Email
          </label>
          <input
            id="signin-email"
            className="tf"
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
          <label className="field__label" htmlFor="signin-password">
            Password
          </label>
          <input
            id="signin-password"
            className="tf"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={because !== null}
            aria-describedby={because === null ? undefined : 'signin-password-error'}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
          {because === null ? null : (
            <div role="alert">
              <FieldError controlId="signin-password" say={because} />
            </div>
          )}
        </div>
        <div className="field">
          <label className="field__label" htmlFor="signin-business">
            Business
          </label>
          <select
            id="signin-business"
            className="tf"
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
        <div className="signin__foot">
          <button className="btn btn--primary" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
      {/* The version stamp's fixed place when there is no rail (S0-1). */}
      <p className="rail__build signin__build" data-build={props.build ?? ''}>
        {props.build === null || props.build === undefined
          ? 'Build not stamped'
          : `Build ${props.build}`}
      </p>
    </main>
  );
}
