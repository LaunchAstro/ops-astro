// SPDX-License-Identifier: AGPL-3.0-only
//
// `/reset`, signed out. With no link, the person asks for one by address,
// and every address gets the same answer. With a mailed link,
// `/reset#token_hash=<hash>`, they choose a new password.
//
// The hash is in the fragment, which no request carries to a server. The
// page takes it once, then clears it from the address bar and the tab's
// history entry before it draws or asks anything, and holds it in memory
// alone. "Change password" makes the calls in their fixed order
// (`changePassword`, `session/recovery.ts`). The recovery session's token
// stays in this page's memory and nowhere else, so nobody is signed in, and
// the person goes to sign in with the new password. A session of the same
// login that the tab still holds, which the reset ended, is forgotten too, so
// sign-in asks for the new password; another login's session is left alone.

import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { BrandMark, FieldError } from '@launchastro/ui';
import { pathTo } from '../routes.ts';
import type { SessionStore } from '../session/token.ts';
import {
  changePassword,
  requestReset,
  type RecoveryRoute,
  type RecoverySession,
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
  /** The tab's session, forgotten after a reset when it is the same login's. */
  readonly sessions: Pick<SessionStore, 'session' | 'clear'>;
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

/** Why the chosen password was not taken, or nothing. */
type Refusal = 'mismatch' | 'refused' | 'failed' | null;

const REFUSALS: Readonly<Record<Exclude<Refusal, null>, string>> = {
  mismatch: 'The two passwords are not the same.',
  refused: 'Choose another password. That one was not accepted.',
  failed: 'We could not confirm your new password. Try again.',
};

/** The page's state, and its one submit: ask for a link, or change the password. */
function useReset(props: ResetScreenProps, link: string) {
  const [stage, setStage] = useState<Stage>(link === '' ? 'ask' : 'choose');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [refusal, setRefusal] = useState<Refusal>(null);
  const opened = useRef<RecoverySession | null>(null);
  const route: RecoveryRoute = {
    gotrueUrl: props.gotrueUrl,
    apiOrigin: props.apiOrigin,
    fetch: props.fetch,
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (stage === 'ask' || stage === 'asking') {
      setStage('asking');
      void (async () => {
        setStage((await requestReset(route, email.trim())) ? 'asked' : 'failed');
      })();
      return;
    }
    setRefusal(password === confirm ? null : 'mismatch');
    if (password !== confirm) return;
    setStage('changing');
    void (async () => {
      const outcome = await changePassword(route, link, opened, password);
      if ('refusal' in outcome) setRefusal(outcome.refusal);
      if ('email' in outcome) {
        setPassword('');
        setConfirm('');
        const reset = outcome.email.toLowerCase();
        if (reset !== '' && props.sessions.session?.email.toLowerCase() === reset) {
          props.sessions.clear();
        }
      }
      setStage('refusal' in outcome ? 'choose' : outcome.stage);
    })();
  };
  const fields = { email, setEmail, password, setPassword, confirm, setConfirm };
  return { stage, refusal, fields, onSubmit };
}

type Fields = ReturnType<typeof useReset>['fields'];

/** One labelled input; the confirmation carries the refusal, when there is one. */
function TextField(props: {
  readonly id: string;
  readonly label: string;
  readonly type: 'email' | 'password';
  readonly autoComplete: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly refusal?: Refusal;
}): ReactElement {
  const refusal = props.refusal ?? null;
  return (
    <div className="field">
      <label className="field__label" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        className="tf"
        type={props.type}
        autoComplete={props.autoComplete}
        required
        aria-invalid={refusal !== null}
        aria-describedby={refusal === null ? undefined : `${props.id}-error`}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      />
      {refusal === null ? null : (
        <div role="alert">
          <FieldError controlId={props.id} say={REFUSALS[refusal]} />
        </div>
      )}
    </div>
  );
}

/** The form's one button, busy while its call is out. */
function Submit(props: {
  readonly busy: boolean;
  readonly label: string;
  readonly busyLabel: string;
}) {
  return (
    <div className="signin__foot">
      <button
        className="btn btn--primary"
        type="submit"
        disabled={props.busy}
        aria-busy={props.busy}
      >
        {props.busy ? props.busyLabel : props.label}
      </button>
    </div>
  );
}

/** With no link: the address to mail one to. */
function AskFields(props: { readonly fields: Fields; readonly busy: boolean }): ReactElement {
  const { fields } = props;
  return (
    <>
      <TextField
        id="reset-email"
        label="Email"
        type="email"
        autoComplete="username"
        value={fields.email}
        onChange={fields.setEmail}
      />
      <Submit busy={props.busy} label="Send me a link" busyLabel="Sending…" />
    </>
  );
}

/** With a link: the new password, twice. */
function ChooseFields(props: {
  readonly fields: Fields;
  readonly refusal: Refusal;
  readonly busy: boolean;
}): ReactElement {
  const { fields } = props;
  return (
    <>
      <TextField
        id="reset-password"
        label="New password"
        type="password"
        autoComplete="new-password"
        value={fields.password}
        onChange={fields.setPassword}
      />
      <TextField
        id="reset-confirm"
        label="New password again"
        type="password"
        autoComplete="new-password"
        value={fields.confirm}
        onChange={fields.setConfirm}
        refusal={props.refusal}
      />
      <Submit busy={props.busy} label="Change password" busyLabel="Changing…" />
    </>
  );
}

/** What happened, and where to go next. */
function Outcome(props: { readonly stage: Stage }): ReactElement {
  const { stage } = props;
  const words = WORDS[stage];
  return (
    <>
      {stage === 'changed' ? (
        <div className="banner banner--info" role="status" data-outcome="changed">
          <p className="banner__body">
            Your password is changed, and every session that used the old one has ended.
          </p>
        </div>
      ) : null}
      {words === undefined ? null : (
        <div className="banner banner--info" role="status" data-outcome={stage}>
          <p className="banner__body">{words}</p>
        </div>
      )}
      <p>
        {stage === 'invalid' ? <a href={pathTo('agency:reset')}>Ask for a new link</a> : null}{' '}
        <a href={pathTo('agency:sign-in')}>
          {stage === 'changed' ? 'Sign in with your new password' : 'Back to sign in'}
        </a>
      </p>
    </>
  );
}

export function ResetScreen(props: ResetScreenProps): ReactElement {
  // Taken once, before the first draw: the link never stays in the address.
  const [link] = useState(() => takeLink(props.path, props.tab));
  const reset = useReset(props, link);
  const { stage, fields } = reset;
  return (
    <main className="signin" data-screen="reset" data-stage={stage}>
      <form className="signin__form card" aria-labelledby="reset-title" onSubmit={reset.onSubmit}>
        <div className="signin__brand">
          <BrandMark variant="wordmark" />
          <span className="rail__hub">Ops Astro</span>
        </div>
        <h1 className="card__title" id="reset-title">
          Reset your password
        </h1>
        {stage === 'ask' || stage === 'asking' ? (
          <AskFields fields={fields} busy={stage === 'asking'} />
        ) : null}
        {stage === 'choose' || stage === 'changing' ? (
          <ChooseFields fields={fields} refusal={reset.refusal} busy={stage === 'changing'} />
        ) : null}
        <Outcome stage={stage} />
      </form>
    </main>
  );
}
