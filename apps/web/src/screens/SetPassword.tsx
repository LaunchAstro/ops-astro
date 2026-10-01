// SPDX-License-Identifier: AGPL-3.0-only
//
// `/reset` (C40, piece P3): the page a reset link opens. The link carries the
// login provider's recovery token in its fragment (`#token_hash=...`), which
// no server's log sees; the page keeps it and takes it off the address at
// once, so it is not left in the address bar or the tab's history.
//
// Nothing is asked of the provider until the new password is sent, so a mail
// scanner that opens the link spends nothing. Then the provider verifies the
// token as it checks a sign-in (`session/recovery.ts`), spending it, and the
// password goes to `POST /api/password/set` with the recovery session's
// bearer. The bearer is kept while the page is open, so a password the API
// refuses, or an API that did not answer, is tried again without the link.
//
// The answers: done, which leads to sign-in (every session of the login has
// ended, this one too); a link that is used, expired or missing, said once for
// all of them, with the way to ask for a new one; the password rules, at the
// field; and unavailable, which keeps the form. Built from the kit and the
// Enrol page's classes: no new style.

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Banner, Button, FieldError } from '@launchastro/ui';
import { pathTo } from '../routes.ts';
import { recoveryTokenOf, setPassword, verifyRecovery } from '../session/recovery.ts';

/** What the page needs of the application: the provider and the API, and where to go next. */
interface SetApp {
  readonly gotrueUrl: string;
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
  readonly navigate: (path: string, options?: { readonly replace?: boolean }) => void;
}

/** The password bounds, as the API checks them: 12 to 72 bytes. */
const LEAST = 12;
const MOST = 72;
const BOUNDS = `Use ${String(LEAST)} to ${String(MOST)} characters.`;
const UNAVAILABLE =
  'Setting a password is not available right now. Nothing changed; try again in a minute.';

type Ended = 'done' | 'invalid';

const SAID: Readonly<Record<Ended, string>> = {
  done: 'Your new password is set, and everywhere you were signed in has been signed out. Sign in with your email address and your new password. If you use an authenticator app, sign-in still asks for its code.',
  invalid:
    'This link has been used, has expired or is not complete. A reset link works once, within an hour of being sent. Ask for a new one.',
};

const NEXT: Readonly<Record<Ended, { readonly label: string; readonly to: string }>> = {
  done: { label: 'Go to sign in', to: pathTo('agency:sign-in') },
  invalid: { label: 'Ask for a new link', to: pathTo('agency:forgot-password') },
};

function Done(props: { readonly ended: Ended; readonly app: SetApp }): ReactElement {
  const next = NEXT[props.ended];
  return (
    <div className="signin">
      <div className="signin__form" data-reset={props.ended}>
        <h2 className="tpr__title">Set a new password</h2>
        <Banner tone={props.ended === 'done' ? 'info' : 'bad'}>{SAID[props.ended]}</Banner>
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            props.app.navigate(next.to);
          }}
        >
          {next.label}
        </Button>
      </div>
    </div>
  );
}

/** Takes the token off the address once, so it is not left in the address bar or the history. */
function useOffTheAddress(fragment: string, app: SetApp): void {
  const cleared = useRef(false);
  useEffect(() => {
    if (cleared.current || fragment === '') return;
    cleared.current = true;
    app.navigate(pathTo('agency:reset'), { replace: true });
  }, [fragment, app]);
}

/** The form, its password paired with its error the way the Enrol page pairs its own. */
function PasswordForm(props: {
  readonly password: string;
  readonly because: string | null;
  readonly busy: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): ReactElement {
  const { because } = props;
  const busy = props.busy ? 'Setting it…' : undefined;
  return (
    <div className="signin">
      <form className="signin__form taskform" data-reset="form" onSubmit={props.onSubmit}>
        <h2 className="tpr__title">Set a new password</h2>
        <p className="field__hint">
          Choose a new password for your login. Setting it signs you out everywhere, and you then
          sign in with it.
        </p>
        <div className="field">
          <label className="tf__k" htmlFor="reset-password">
            New password
          </label>
          <input
            id="reset-password"
            className="input"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={because !== null}
            aria-describedby={because === null ? undefined : 'reset-password-error'}
            value={props.password}
            onChange={(event) => {
              props.onChange(event.target.value);
            }}
          />
        </div>
        {because === null ? null : (
          <div role="alert">
            <FieldError controlId="reset-password" say={because} />
          </div>
        )}
        <Button variant="primary" size="md" type="submit" busy={busy}>
          Set password
        </Button>
      </form>
    </div>
  );
}

export function SetPassword(props: {
  readonly fragment: string;
  readonly app: SetApp;
}): ReactElement {
  const { app } = props;
  // Read once: the address loses its fragment, and the page keeps the token.
  const [token] = useState(() => recoveryTokenOf(props.fragment));
  const bearer = useRef<string | null>(null);
  const [password, setValue] = useState('');
  const [because, setBecause] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState<Ended | null>(token === null ? 'invalid' : null);
  useOffTheAddress(props.fragment, app);
  if (ended !== null || token === null) return <Done ended={ended ?? 'invalid'} app={app} />;

  const send = async (): Promise<void> => {
    if (bearer.current === null) {
      const verified = await verifyRecovery(app, token);
      if (!verified.ok) {
        if (verified.why === 'invalid') setEnded('invalid');
        else setBecause(UNAVAILABLE);
        return;
      }
      bearer.current = verified.bearer;
    }
    const outcome = await setPassword(app, bearer.current, password);
    if (outcome === 'done' || outcome === 'invalid') setEnded(outcome);
    else setBecause(outcome === 'password' ? BOUNDS : UNAVAILABLE);
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const bytes = new TextEncoder().encode(password).length;
    const outOfBounds = bytes < LEAST || bytes > MOST;
    setBecause(outOfBounds ? BOUNDS : null);
    if (outOfBounds) return;
    setBusy(true);
    void send().finally(() => {
      setBusy(false);
    });
  };
  return <PasswordForm {...{ password, because, busy, onSubmit }} onChange={setValue} />;
}
