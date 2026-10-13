// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's acts (C32, C58, C39-T): each section sends one write at
// a time through `useAct` and draws its own outcome line in the server's words.

import { useRef, useState, type ReactElement } from 'react';
import { describeFailure, type SubmitResult } from '../../records/submit.ts';

/**
 * One write, then the list read again; a refusal changes nothing but the
 * outcome line. Null when another act of its section was still out, so nothing
 * was sent.
 */
export type Act = (send: () => Promise<SubmitResult>, done: string) => Promise<SubmitResult | null>;

/** The outcome line for an act held back while another is out. */
const HELD = 'Not sent: another act is still being sent. Try again once it has answered.';

/** A refusal is drawn as Settings draws one; a success stays a quiet line. */
const Outcome = (props: { readonly text: string; readonly refused: boolean }): ReactElement =>
  props.refused ? (
    <p className="field__error" role="alert" data-access-outcome="refused">
      {props.text}
    </p>
  ) : (
    <p className="card__sub" role="status" data-access-outcome="done">
      {props.text}
    </p>
  );

/**
 * One write at a time: a second while one is out sends nothing and says so.
 * After one that worked the list is read again; after any answer the
 * invitations are.
 */
export function useAct(reload: () => void) {
  const out = useRef(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [outcome, setOutcome] = useState<{ text: string; refused: boolean } | null>(null);
  const act: Act = async (send, done) => {
    if (out.current) {
      setOutcome({ text: HELD, refused: true });
      return null;
    }
    out.current = true;
    setBusy(true);
    const result = await send();
    out.current = false;
    const failure = describeFailure(result);
    setBusy(false);
    setOutcome({ text: failure ?? done, refused: failure !== null });
    if (failure === null) reload();
    setVersion((was) => was + 1);
    return result;
  };
  const line = outcome === null ? null : <Outcome {...outcome} />;
  return { act, busy, version, outcome: line };
}
