// SPDX-License-Identifier: AGPL-3.0-only
//
// `/reset`, signed out. With no link, the person asks for one by address,
// and every address gets the same answer. With a mailed link,
// `/reset#token_hash=<hash>`, they choose a new password.
//
// The hash is in the fragment, which no request carries to a server. The
// page takes it once, then clears it from the address bar and the tab's
// history entry before it draws or asks anything, and holds it in memory
// alone. On "Change password" the page, in order (`session/recovery.ts`):
// opens the provider's one-time recovery session with the hash; asks the API
// to begin the reset, which ends every session of the login; writes the new
// password to the provider on that session; tells the API it is changed;
// signs out everywhere at the provider. The session's token stays in this
// page's memory and nowhere else, so nobody is signed in, and the person
// goes to sign in with the new password.

import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { BrandMark, FieldError } from '@launchastro/ui';
import { pathTo } from '../routes.ts';
import {
  beginReset,
  confirmChanged,
  requestReset,
  setNewPassword,
  signOutEverywhere,
  verifyRecovery,
  type RecoveryRoute,
} from '../session/recovery.ts';

export interface ResetScreenProps {
  /** The whole address, fragment included, as the tab held it on arrival. */
  readonly path: string;
  /** The login provider's address. */
  readonly gotrueUrl: string;
  readonly apiOrigin: string;
  readonly fetch: typeof globalThis.fetch;
  /** The tab whose address bar and history entry the link is cleared from. */
  readonly tab: Pick<Window, 'location' | 'history'>;
}

type Stage =
  | 'ask'
  | 'asking'
  | 'asked'
  | 'choose'
  | 'changing'
  | 'changed'
  | 'invalid'
  | 'needs-support'
  | 'failed';

const WORDS: Readonly<Partial<Record<Stage, string>>> = {
  asked:
    'If an account uses that address, we have sent it a link to reset the password. The link works once, for 30 minutes.',
  invalid:
    'This reset link cannot be used. It may have been used already, replaced by a newer one or expired. Ask for a new link.',
  'needs-support':
    'Your account uses an authenticator app, so a reset needs support. Contact your administrator.',
  failed: 'Something went wrong on our side. Your password was not changed; try again in a minute.',
};

/** The link's hash from the arrival address, the address bar cleared of it first. */
function takeLink(path: string, tab: ResetScreenProps['tab']): string {
  const hash = new URL(path, 'http://here').hash.slice(1);
  if (tab.location.hash !== '') {
    tab.history.replaceState(
      tab.history.state,
      '',
      `${tab.location.pathname}${tab.location.search}`,
    );
  }
  return new URLSearchParams(hash).get('token_hash') ?? '';
}

/** The recovery session, once opened: in memory, for a second try at the password. */
interface Opened {
  readonly accessToken: string;
  readonly subject: string;
}

/** Why the chosen password was not taken, or nothing. */
type Refusal = 'mismatch' | 'refused' | 'failed' | null;

const REFUSALS: Readonly<Record<Exclude<Refusal, null>, string>> = {
  mismatch: 'The two passwords are not the same.',
  refused: 'Choose another password. That one was not accepted.',
  failed: 'Your password was not changed. Try again.',
};

/** Open, begin, write: the stage the page goes to, or why the password form stays. */
async function change(
  route: RecoveryRoute,
  link: string,
  opened: { current: Opened | null },
  password: string,
): Promise<{ readonly stage: Stage } | { readonly refusal: 'refused' | 'failed' }> {
  if (opened.current === null) {
    const session = await verifyRecovery(route, link);
    if (session === undefined) return { stage: 'invalid' };
    opened.current = session;
  }
  const { accessToken, subject } = opened.current;
  const begun = await beginReset(route, accessToken);
  if (begun !== 'begun') return { stage: begun };
  const written = await setNewPassword(route, accessToken, subject, password);
  if (written !== 'set') return { refusal: written };
  // Settles the window now; refused or lost, the window ends at its bound, five minutes on.
  await confirmChanged(route, accessToken);
  return { stage: 'changed' };
}

export function ResetScreen(props: ResetScreenProps): ReactElement {
  // Taken once, before the first draw: the link never stays in the address.
  const [link] = useState(() => takeLink(props.path, props.tab));
  const [stage, setStage] = useState<Stage>(link === '' ? 'ask' : 'choose');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [refusal, setRefusal] = useState<Refusal>(null);
  const [signedOut, setSignedOut] = useState(true);
  const opened = useRef<Opened | null>(null);
  const route: RecoveryRoute = {
    gotrueUrl: props.gotrueUrl,
    apiOrigin: props.apiOrigin,
    fetch: props.fetch,
  };

  const onAsk = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setStage('asking');
    void (async () => {
      setStage((await requestReset(route, email.trim())) ? 'asked' : 'failed');
    })();
  };

  const onChange = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (password !== confirm) {
      setRefusal('mismatch');
      return;
    }
    setRefusal(null);
    setStage('changing');
    void (async () => {
      const outcome = await change(route, link, opened, password);
      if ('refusal' in outcome) {
        setRefusal(outcome.refusal);
        setStage('choose');
        return;
      }
      if (outcome.stage !== 'changed') {
        setStage(outcome.stage);
        return;
      }
      setPassword('');
      setConfirm('');
      const session = opened.current;
      opened.current = null;
      setSignedOut(session === null ? true : await signOutEverywhere(route, session.accessToken));
      setStage('changed');
    })();
  };

  const asking = stage === 'ask' || stage === 'asking';
  const choosing = stage === 'choose' || stage === 'changing';
  return (
    <main className="signin" data-screen="reset" data-stage={stage}>
      <form
        className="signin__form card"
        aria-labelledby="reset-title"
        onSubmit={asking ? onAsk : onChange}
      >
        <div className="signin__brand">
          <BrandMark variant="wordmark" />
          <span className="rail__hub">Ops Astro</span>
        </div>
        <h1 className="card__title" id="reset-title">
          Reset your password
        </h1>
        {asking ? (
          <>
            <div className="field">
              <label className="field__label" htmlFor="reset-email">
                Email
              </label>
              <input
                id="reset-email"
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
            <div className="signin__foot">
              <button
                className="btn btn--primary"
                type="submit"
                disabled={stage === 'asking'}
                aria-busy={stage === 'asking'}
              >
                {stage === 'asking' ? 'Sending…' : 'Send me a link'}
              </button>
            </div>
          </>
        ) : null}
        {choosing ? (
          <>
            <div className="field">
              <label className="field__label" htmlFor="reset-password">
                New password
              </label>
              <input
                id="reset-password"
                className="tf"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                }}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="reset-confirm">
                New password again
              </label>
              <input
                id="reset-confirm"
                className="tf"
                type="password"
                autoComplete="new-password"
                required
                aria-invalid={refusal !== null}
                aria-describedby={refusal === null ? undefined : 'reset-confirm-error'}
                value={confirm}
                onChange={(event) => {
                  setConfirm(event.target.value);
                }}
              />
              {refusal === null ? null : (
                <div role="alert">
                  <FieldError controlId="reset-confirm" say={REFUSALS[refusal]} />
                </div>
              )}
            </div>
            <div className="signin__foot">
              <button
                className="btn btn--primary"
                type="submit"
                disabled={stage === 'changing'}
                aria-busy={stage === 'changing'}
              >
                {stage === 'changing' ? 'Changing…' : 'Change password'}
              </button>
            </div>
          </>
        ) : null}
        {stage === 'changed' ? (
          <div className="banner banner--info" role="status" data-outcome="changed">
            <p className="banner__body">
              Your password is changed, and every session that used the old one has ended.
              {signedOut
                ? ''
                : " Signed out here, but we couldn't confirm the sign-out everywhere."}
            </p>
          </div>
        ) : null}
        {WORDS[stage] === undefined ? null : (
          <div className="banner banner--info" role="status" data-outcome={stage}>
            <p className="banner__body">{WORDS[stage]}</p>
          </div>
        )}
        <p>
          {stage === 'invalid' ? <a href={pathTo('agency:reset')}>Ask for a new link</a> : null}{' '}
          <a href={pathTo('agency:sign-in')}>
            {stage === 'changed' ? 'Sign in with your new password' : 'Back to sign in'}
          </a>
        </p>
      </form>
    </main>
  );
}
