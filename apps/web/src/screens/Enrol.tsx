// SPDX-License-Identifier: AGPL-3.0-only
//
// `/enrol/:token` (C39-T, piece P3). The page an invitation's link opens: set
// a password, submit, and the invitation is accepted. It is drawn the same
// whether or not anyone is signed in, and it signs nobody in: when it is
// done, the person signs in with their address and the password they set,
// as anyone does.
//
// The token goes to the API in the body (`POST /api/enrol`), never as an
// address the API logs, and no credential goes with it. Four answers:
// `enrolled`; `sign_in`, when the address already holds a login, which tells
// them to sign in with it; a link that is no longer good (used, expired,
// revoked or replaced by a newer invitation), said once for all of them; and
// the login provider being unavailable, which keeps the form and the link.
//
// Signed in, the page also offers to accept as the signed-in person: the
// token alone goes to `POST /api/b/enrol` with this tab's session, and the
// login they hold is bound to the invitation, no password asked. A link
// that is dead, or not for the address they are signed in with, is one
// answer, said once.
//
// Built from the kit and the sign-in form's own classes: no new style.

import { useState, type FormEvent, type ReactElement } from 'react';
import { Banner, Button, FieldError } from '@launchastro/ui';
import { postOpen, type ClientOptions } from '../operations/client.ts';
import { postWithSession } from '../operations/session-post.ts';
import { pathTo } from '../routes.ts';
import type { Session } from '../session/token.ts';

/** The API's enrolment route (`apps/api/enrolment.ts`). */
export const ENROL_API = '/api/enrol';

/** The same link accepted with the signed-in session (`apps/api/enrolment.ts`). */
export const ENROL_SIGNED_IN_API = '/api/b/enrol';

/** The page's password bounds, as the API checks them: 12 to 72 bytes. */
const LEAST = 12;
const MOST = 72;
const BOUNDS = `Use ${String(LEAST)} to ${String(MOST)} characters.`;

/** What the page needs of the application: where the API is, and where to go next. */
export interface EnrolApp extends Pick<ClientOptions, 'fetch'> {
  readonly apiOrigin: string;
  readonly navigate: (path: string) => void;
}

type Ended = 'enrolled' | 'sign_in' | 'invalid' | 'joined' | 'not_yours';

/** One POST and the outcome it names; anything unexpected is `unavailable`. */
async function enrol(
  app: EnrolApp,
  token: string,
  password: string,
): Promise<Ended | 'password' | 'unavailable'> {
  try {
    const body = (await postOpen(app, ENROL_API, { token, password })) as {
      state?: unknown;
      code?: unknown;
    };
    if (body.state === 'enrolled' || body.state === 'sign_in') return body.state;
    if (body.code === 'ENROLMENT_LINK_INVALID') return 'invalid';
    return body.code === 'PASSWORD_INVALID' ? 'password' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/** What the page says when an accept did not end the page. */
const UNAVAILABLE = 'Sign-in is not available right now. Nothing changed; try again in a minute.';
const SESSION_GONE = 'Your sign-in has ended. Sign in again, then open this link.';

/** The signed-in accept: one POST and the outcome it names, or the words for one that did not end. */
async function acceptAs(
  app: EnrolApp,
  token: string,
  session: Session,
): Promise<{ readonly ended: 'joined' | 'not_yours' } | { readonly because: string }> {
  try {
    const body = (await postWithSession(app, ENROL_SIGNED_IN_API, session.sessionId, {
      token,
    })) as { state?: unknown; code?: unknown };
    if (body.state === 'joined') return { ended: 'joined' };
    if (body.code === 'ENROLMENT_LINK_INVALID') return { ended: 'not_yours' };
    const gone = typeof body.code === 'string' && body.code.startsWith('AUTH_');
    return { because: gone ? SESSION_GONE : UNAVAILABLE };
  } catch {
    return { because: UNAVAILABLE };
  }
}

const SAID: Readonly<Record<Ended, string>> = {
  enrolled: 'Your login is ready. Sign in with your email address and the password you just set.',
  sign_in:
    'This email address already has a login. Sign in with it to accept the invitation. Your link still works.',
  invalid:
    'This link has been used, has expired or has been replaced by a newer invitation. Ask whoever invited you to send it again.',
  joined:
    'You have joined the team with the login you are signed in with. To work there, choose its business when you next sign in.',
  not_yours:
    'This link cannot be accepted with this login. It may have been used, expired or been replaced, or it was sent to another email address than the one you are signed in with.',
};

/** Where the page goes after an answer: sign-in, the board, or nowhere. */
const NEXT: Readonly<Record<Ended, { label: string; to: string } | null>> = {
  enrolled: { label: 'Go to sign in', to: pathTo('agency:sign-in') },
  sign_in: { label: 'Go to sign in', to: pathTo('agency:sign-in') },
  invalid: null,
  joined: { label: 'Go to your work', to: pathTo('agency:projects-board') },
  not_yours: null,
};

/** The page after an answer that ends the form. */
function Done(props: { readonly ended: Ended; readonly app: EnrolApp }): ReactElement {
  const next = NEXT[props.ended];
  return (
    <div className="signin">
      <div className="signin__form" data-enrol={props.ended}>
        <h2 className="tpr__title">Join your team</h2>
        <Banner tone={next === null ? 'bad' : 'info'}>{SAID[props.ended]}</Banner>
        {next === null ? null : (
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              props.app.navigate(next.to);
            }}
          >
            {next.label}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The password field, paired with its error the way the sign-in form pairs its own. */
function PasswordField(props: {
  readonly value: string;
  readonly because: string | null;
  readonly onChange: (value: string) => void;
}): ReactElement {
  return (
    <>
      <div className="field">
        <label className="tf__k" htmlFor="enrol-password">
          Password
        </label>
        <input
          id="enrol-password"
          className="input"
          type="password"
          autoComplete="new-password"
          required
          aria-invalid={props.because !== null}
          aria-describedby={props.because === null ? undefined : 'enrol-password-error'}
          value={props.value}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
        />
      </div>
      {props.because === null ? null : (
        <div role="alert">
          <FieldError controlId="enrol-password" say={props.because} />
        </div>
      )}
    </>
  );
}

/** Signed in: accept as that person, with the login they hold; what went wrong, when it did. */
function AcceptAs(props: {
  readonly session: Session;
  readonly token: string;
  readonly app: EnrolApp;
  readonly onEnded: (ended: Ended) => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [because, setBecause] = useState<string | null>(null);
  const onAccept = (): void => {
    setBusy(true);
    setBecause(null);
    void (async () => {
      const said = await acceptAs(props.app, props.token, props.session);
      setBusy(false);
      if ('ended' in said) props.onEnded(said.ended);
      else setBecause(said.because);
    })();
  };
  return (
    <div className="field" data-enrol="signed-in">
      <p className="field__hint">
        You are signed in as {props.session.email}. Accept with this login, or set a password for a
        new one below.
      </p>
      {because === null ? null : <Banner tone="bad">{because}</Banner>}
      <Button variant="primary" size="md" onClick={onAccept} busy={busy ? 'Accepting…' : undefined}>
        Accept as {props.session.email}
      </Button>
    </div>
  );
}

export function Enrol(props: {
  readonly token: string;
  readonly app: EnrolApp;
  readonly session?: Session | null;
}): ReactElement {
  const [password, setPassword] = useState('');
  const [because, setBecause] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState<Ended | null>(null);
  if (ended !== null) return <Done ended={ended} app={props.app} />;
  const session = props.session ?? null;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const bytes = new TextEncoder().encode(password).length;
    setBecause(bytes < LEAST || bytes > MOST ? BOUNDS : null);
    if (bytes < LEAST || bytes > MOST) return;
    setBusy(true);
    void (async () => {
      const said = await enrol(props.app, props.token, password);
      setBusy(false);
      if (said === 'password') setBecause(BOUNDS);
      else if (said === 'unavailable') setBecause(UNAVAILABLE);
      else setEnded(said);
    })();
  };

  return (
    <div className="signin">
      <form className="signin__form taskform" data-enrol="form" onSubmit={onSubmit}>
        <h2 className="tpr__title">Join your team</h2>
        {session === null ? null : (
          <AcceptAs session={session} token={props.token} app={props.app} onEnded={setEnded} />
        )}
        <p className="field__hint">
          Set a password for your login. You sign in with your email address and this password.
        </p>
        <PasswordField value={password} because={because} onChange={setPassword} />
        <Button
          variant={session === null ? 'primary' : 'secondary'}
          size="md"
          type="submit"
          busy={busy ? 'Setting it…' : undefined}
        >
          Set password
        </Button>
      </form>
    </div>
  );
}
