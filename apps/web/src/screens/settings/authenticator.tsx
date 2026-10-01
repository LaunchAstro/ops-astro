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

import { useContext, useEffect, useRef, useState, type ReactElement } from 'react';
import { Button, Card } from '@launchastro/ui';
import type { IssuedFactor, OperationsClient } from '../../operations/client.ts';
import { describeFailure } from '../../records/submit.ts';
import { StepUpContext } from '../../records/use-money-command.ts';
import { CodeField } from '../../views/step-up-prompt.tsx';

const SVG_QR = 'data:image/svg+xml';
const SIX_DIGITS = /^\d{6}$/u;
const NO_SECRET = 'The API answered with no set-up to show. Try again.';

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
  | { readonly at: 'done' };

const IDLE: Stage = { at: 'idle', said: null };

/** The answer as the page draws it, or the words for an answer it cannot. */
function stageOf(issued: IssuedFactor): Stage {
  const { qrCode, secret } = issued;
  if (typeof secret !== 'string' || secret === '') return { at: 'idle', said: NO_SECRET };
  const qr = typeof qrCode === 'string' && qrCode.startsWith(SVG_QR) ? qrCode : null;
  return { at: 'shown', shown: { qr, secret } };
}

/** The enrol and its stage; every answer is dropped once cancelled or left. */
function useEnrol(client: OperationsClient) {
  const [stage, setStage] = useState<Stage>(IDLE);
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
    void (async () => {
      const result = await client.enrolFactor();
      if (asked.current !== mine) return;
      setStage(
        'ok' in result ? stageOf(result.value) : { at: 'idle', said: describeFailure(result) },
      );
    })();
  };
  const cancel = (): void => {
    asked.current += 1;
    setStage(IDLE);
  };
  return { stage, start, cancel, done: () => setStage({ at: 'done' }) };
}

/** The first code, through the application's one step-up; its state goes with the form. */
function useFirstCode(onDone: () => void) {
  const stepUp = useContext(StepUpContext);
  const [code, setCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [because, setBecause] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const ready = stepUp !== null && SIX_DIGITS.test(code) && !checking;
  const submit = (): void => {
    if (!ready) return;
    setChecking(true);
    setBecause(null);
    void (async () => {
      const result = await stepUp(code);
      if (!alive.current) return;
      setChecking(false);
      if (result.ok) onDone();
      else setBecause(result.because);
    })();
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
      <div className="btnrow">
        <span data-factor="confirm">
          <Button
            variant="primary"
            type="submit"
            disabled={!ready}
            busy={checking ? 'Checking…' : undefined}
          >
            Confirm code
          </Button>
        </span>
        <span data-factor="cancel">
          <Button variant="ghost" disabled={checking} onClick={props.onCancel}>
            Cancel
          </Button>
        </span>
      </div>
    </form>
  );
}

export function AuthenticatorSetup(props: { readonly client: OperationsClient }): ReactElement {
  const signedIn = useContext(StepUpContext) !== null;
  const { stage, start, cancel, done } = useEnrol(props.client);
  return (
    <section className="sb__sect" data-factor="panel">
      <Card
        title="Authenticator app"
        sub="Money changes ask for a six-digit code from an app on your phone."
      >
        <div className="stack">
          {stage.at === 'idle' && stage.said !== null ? (
            <p className="card__sub" role="status" data-factor="outcome">
              {stage.said}
            </p>
          ) : null}
          {stage.at === 'done' ? (
            <p className="card__sub" role="status" data-factor="done">
              Your authenticator app is set up. Any other session of yours was signed out.
            </p>
          ) : null}
          {stage.at === 'shown' ? (
            <Issued shown={stage.shown} onDone={done} onCancel={cancel} />
          ) : null}
          {stage.at === 'idle' || stage.at === 'asking' ? (
            <div className="btnrow">
              <span data-factor="enrol">
                <Button
                  busy={stage.at === 'asking' ? 'Setting up…' : undefined}
                  disabled={!signedIn}
                  reason="Sign in to set up an authenticator app."
                  onClick={start}
                >
                  Set up authenticator app
                </Button>
              </span>
              {stage.at === 'asking' ? (
                <span data-factor="cancel">
                  <Button variant="ghost" onClick={cancel}>
                    Cancel
                  </Button>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
