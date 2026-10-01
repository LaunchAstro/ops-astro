// SPDX-License-Identifier: AGPL-3.0-only
//
// `/forgot-password` (C40, piece P3), linked from sign-in. An email address,
// sent in the body to `POST /api/password/reset` with no credential. The API
// answers the same for every address, known or not, so the page has one
// answer too: if that address has an account, a link is on its way. The only
// other thing it can say is that the ask never reached the API, which keeps
// the form and says nothing about the address either.
//
// Drawn signed in or out, and built from the kit and the Enrol page's classes,
// as the Enrol page is from the sign-in form's: no new style.

import { useState, type FormEvent, type ReactElement } from 'react';
import { Banner, Button } from '@launchastro/ui';
import { pathTo } from '../routes.ts';
import { askReset } from '../session/recovery.ts';

/** What the page needs of the application: where the API is, and where to go next. */
interface ForgotApp {
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
  readonly navigate: (path: string) => void;
}

const SENT =
  'If that address has an account, a link to set a new password is on its way. The link works once and expires within an hour. If nothing arrives in a few minutes, check your junk mail, then ask again.';
const UNAVAILABLE = 'That did not reach us. Nothing was sent; try again in a minute.';

function BackToSignIn(props: {
  readonly app: ForgotApp;
  readonly variant: 'secondary' | 'text';
}): ReactElement {
  return (
    <Button
      variant={props.variant}
      size="md"
      onClick={() => {
        props.app.navigate(pathTo('agency:sign-in'));
      }}
    >
      Back to sign in
    </Button>
  );
}

/** The ask: one address, and what went wrong when it did not reach the API. */
function AskForm(props: {
  readonly address: string;
  readonly because: string | null;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): ReactElement {
  return (
    <form className="signin__form taskform" data-reset="ask" onSubmit={props.onSubmit}>
      <h2 className="tpr__title">Forgot password</h2>
      <p className="field__hint">
        Enter the email address you sign in with, and we will email you a link to set a new
        password.
      </p>
      <div className="field">
        <label className="tf__k" htmlFor="reset-address">
          Email
        </label>
        <input
          id="reset-address"
          className="input"
          type="email"
          autoComplete="username"
          required
          value={props.address}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        />
      </div>
      {props.because === null ? null : <Banner tone="bad">{props.because}</Banner>}
      <Button variant="primary" size="md" type="submit" busy={props.busy ? 'Sending…' : undefined}>
        Send reset link
      </Button>
    </form>
  );
}

export function ForgotPassword(props: { readonly app: ForgotApp }): ReactElement {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [because, setBecause] = useState<string | null>(null);
  if (sent) {
    return (
      <div className="signin">
        <div className="signin__form" data-reset="sent">
          <h2 className="tpr__title">Check your email</h2>
          <Banner tone="info">{SENT}</Banner>
          <BackToSignIn app={props.app} variant="secondary" />
        </div>
      </div>
    );
  }
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setBecause(null);
    setBusy(true);
    void (async () => {
      const reached = await askReset(props.app, address.trim());
      setBusy(false);
      if (reached) setSent(true);
      else setBecause(UNAVAILABLE);
    })();
  };
  return (
    <div className="signin">
      <AskForm {...{ address, because, busy, onSubmit }} onChange={setAddress} />
      <BackToSignIn app={props.app} variant="text" />
    </div>
  );
}
