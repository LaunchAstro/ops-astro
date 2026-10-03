// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ General's "Set up an authenticator app" (C59), beside "Your
// sessions": a person enrols the second factor the money step-up asks for.
//
// The enrol is the person's own account route with an empty body; the server
// takes the person from the credential. Its answer is drawn once: the QR as an
// image only when it is an SVG data URL, the secret as text to type in by
// hand. The uri is never kept. The answer lives in this panel's state and
// nowhere else (no storage, no read cache, no address, no console, no error
// string), and goes on success, on cancel and when the page is left.
//
// The first good code goes through the application's one step-up
// (`StepUpContext`, `session/step-up.ts`): checked, its token traded for a new
// cookie, the tab moved to it and the old cookie cleared. The server completes
// the enrolment on that code and ends the person's other sessions.
//
// Changing course (Q2, `authenticator-change.tsx`): "Remove authenticator app"
// takes the current code, and an enrol refused `FACTOR_ALREADY_ENROLLED` opens
// that removal. An enrol refused `FRESH_SIGN_IN_REQUIRED` asks for the
// password; once the tab has signed in again the set-up starts again, on the
// client the application builds for the new sign-in.

import { useContext, useEffect, useRef, useState, type ReactElement } from 'react';
import { Button, Card } from '@launchastro/ui';
import {
  isRefusal,
  type CallResult,
  type IssuedFactor,
  type OperationsClient,
} from '../../operations/client.ts';
import { describeFailure } from '../../records/submit.ts';
import { SignInAgainContext, StepUpContext } from '../../records/use-money-command.ts';
import { CodeField } from '../../views/step-up-prompt.tsx';
import {
  Buttons,
  RemoveForm,
  SIX_DIGITS,
  SignInAgainForm,
  useCheck,
  useRestart,
} from './authenticator-change.tsx';

const SVG_QR = 'data:image/svg+xml';
const NO_SECRET = 'The API answered with no set-up to show. Try again.';
const UNSENT = { unavailable: true, because: 'The set-up did not finish. Try again.' } as const;

/** What the page holds of an issued factor while it is shown. */
interface Shown {
  /** The QR, only when it is an SVG data URL. */
  readonly qr: string | null;
  readonly secret: string;
}

type Stage =
  | { readonly at: 'idle'; readonly said: string | null }
  | { readonly at: 'asking' }
  | { readonly at: 'shown'; readonly shown: Shown }
  | { readonly at: 'done' }
  /** The removal's code form, or the password form, under the words that opened it. */
  | { readonly at: 'removing' | 'signing'; readonly said: string | null }
  | { readonly at: 'removed' };

const IDLE: Stage = { at: 'idle', said: null };

/** The answer as the page draws it, or the words for an answer it cannot. */
function stageOf(issued: IssuedFactor): Stage {
  const { qrCode, secret } = issued;
  if (typeof secret !== 'string' || secret === '') return { at: 'idle', said: NO_SECRET };
  const qr = typeof qrCode === 'string' && qrCode.startsWith(SVG_QR) ? qrCode : null;
  return { at: 'shown', shown: { qr, secret } };
}

/** A refused enrol, in the server's words, with the form its refusal opens. */
function refusedStage(result: CallResult<IssuedFactor>, canSignIn: boolean): Stage {
  const said = describeFailure(result);
  const code = isRefusal(result) ? result.code : null;
  if (code === 'FACTOR_ALREADY_ENROLLED') return { at: 'removing', said };
  if (code === 'FRESH_SIGN_IN_REQUIRED' && canSignIn) return { at: 'signing', said };
  return { at: 'idle', said };
}

// The last enrol sent from any panel, as its settling and not its answer. A cancelled one still
// lands and would replace the factor whose key is shown, so the next waits for it, as Start does.
let landing: Promise<unknown> = Promise.resolve();

/** The enrol and its stage; every answer is dropped once cancelled or left. */
function useEnrol(client: OperationsClient) {
  const canSignIn = useContext(SignInAgainContext) !== null;
  const [stage, setStage] = useState<Stage>(IDLE);
  const [settling, setSettling] = useState(false);
  const asked = useRef(0);
  useEffect(
    () => () => {
      asked.current += 1;
    },
    [],
  );
  const start = (): void => {
    asked.current += 1;
    const mine = asked.current;
    setStage({ at: 'asking' });
    setSettling(true);
    const sent = landing.then(async () => await client.enrolFactor()).catch(() => UNSENT);
    landing = (async () => {
      const result = await sent;
      setSettling(false);
      if (asked.current !== mine) return;
      setStage('ok' in result ? stageOf(result.value) : refusedStage(result, canSignIn));
    })();
  };
  const cancel = (): void => {
    asked.current += 1;
    setStage(IDLE);
  };
  const to = (next: Stage) => () => setStage(next);
  return {
    stage,
    settling,
    setStage,
    start,
    cancel,
    done: to({ at: 'done' }),
    removed: to({ at: 'removed' }),
  };
}

/** The first code, through the application's one step-up; its state goes with the form. */
function useFirstCode(onDone: () => void) {
  const stepUp = useContext(StepUpContext);
  const [code, setCode] = useState('');
  const { checking, because, check } = useCheck(onDone);
  const ready = stepUp !== null && SIX_DIGITS.test(code) && !checking;
  const submit = (): void => {
    if (ready) check(async () => await stepUp(code));
  };
  return { code, setCode, checking, because, ready, submit };
}

/** The QR, only as an SVG data URL, and the key to type in by hand. */
function Secret(props: { readonly shown: Shown }): ReactElement {
  const { qr, secret } = props.shown;
  return (
    <>
      <p className="card__sub">
        Scan this with your authenticator app, or type the key in by hand. It is shown once, here.
      </p>
      {qr === null ? null : (
        <img
          src={qr}
          alt="QR code for your authenticator app"
          width={180}
          height={180}
          data-factor="qr"
        />
      )}
      <p className="card__sub">
        Key: <code data-factor="secret">{secret}</code>
      </p>
    </>
  );
}

/** The issued factor, drawn once, and the first code. */
function Issued(props: {
  readonly shown: Shown;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { code, setCode, checking, because, ready, submit } = useFirstCode(props.onDone);
  return (
    <form
      className="stack"
      aria-label="Set up your authenticator app"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Secret shown={props.shown} />
      <CodeField code={code} onCode={setCode} ask={{ because, checking }} />
      <Buttons
        confirm="confirm"
        label="Confirm code"
        ready={ready}
        checking={checking}
        onCancel={props.onCancel}
      />
    </form>
  );
}

/** What a stage says: a refusal in the server's words, or what was done. */
function Said(props: { readonly stage: Stage }): ReactElement | null {
  const { stage } = props;
  if (stage.at === 'done') {
    return (
      <p className="card__sub" role="status" data-factor="done">
        Your authenticator app is set up. Any other session of yours was signed out.
      </p>
    );
  }
  if (stage.at === 'removed') {
    return (
      <p className="card__sub" role="status" data-factor="removed">
        Your authenticator app is removed. Any other session of yours was signed out.
      </p>
    );
  }
  const said = 'said' in stage ? stage.said : null;
  return said === null ? null : (
    <p className="card__sub" role="status" data-factor="outcome">
      {said}
    </p>
  );
}

/** Set up, and beside it remove, or cancel while a set-up is being asked for. */
function Actions(props: {
  readonly asking: boolean;
  readonly signedIn: boolean;
  readonly settling: boolean;
  readonly removable: boolean;
  readonly onStart: () => void;
  readonly onRemove: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  return (
    <div className="btnrow">
      <span data-factor="enrol">
        <Button
          busy={props.asking ? 'Setting up…' : props.settling ? 'Cancelling…' : undefined}
          disabled={!props.signedIn}
          reason="Sign in to set up an authenticator app."
          onClick={props.onStart}
        >
          Set up authenticator app
        </Button>
      </span>
      {props.asking ? (
        <span data-factor="cancel">
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        </span>
      ) : null}
      {props.removable ? (
        <span data-factor="remove">
          <Button variant="ghost" disabled={!props.signedIn} onClick={props.onRemove}>
            Remove authenticator app
          </Button>
        </span>
      ) : null}
    </div>
  );
}

export function AuthenticatorSetup(props: { readonly client: OperationsClient }): ReactElement {
  const signedIn = useContext(StepUpContext) !== null;
  const { stage, settling, setStage, start, cancel, done, removed } = useEnrol(props.client);
  const restart = useRestart(props.client, start);
  const at = stage.at;
  return (
    <section className="sb__sect" data-factor="panel">
      <Card
        title="Authenticator app"
        sub="Money changes ask for a six-digit code from an app on your phone."
      >
        <div className="stack">
          <Said stage={stage} />
          {at === 'shown' ? <Issued shown={stage.shown} onDone={done} onCancel={cancel} /> : null}
          {at === 'removing' ? (
            <RemoveForm client={props.client} onRemoved={removed} onCancel={cancel} />
          ) : null}
          {at === 'signing' ? (
            <SignInAgainForm
              onSignedIn={() => {
                restart(props.client);
              }}
              onCancel={cancel}
            />
          ) : null}
          {at === 'idle' || at === 'asking' || at === 'removed' ? (
            <Actions
              asking={at === 'asking'}
              signedIn={signedIn}
              settling={settling}
              removable={at === 'idle'}
              onStart={start}
              onRemove={() => {
                setStage({ at: 'removing', said: null });
              }}
              onCancel={cancel}
            />
          ) : null}
        </div>
      </Card>
    </section>
  );
}
