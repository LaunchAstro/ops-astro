// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Access's acts (C32, C58, C39-T): each section sends one write at
// a time through `useAct` and draws its own outcome line in the server's words.
// The lists send through `useHeldSend`, which keeps a lost write's id for the
// same act pressed again.

import { useRef, useState, type ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import { describeFailure, type SubmitResult } from '../../records/submit.ts';
import { settle } from '../../records/use-command.ts';

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

/** The writes the access lists send. */
export type ListCommand =
  'delegation.revoke' | 'access.grant' | 'access.end' | 'access.revoke' | 'client.set_privacy';

/** Sends one list write: under the lost write's id when it is the same act, else a new one. */
export type Send = (
  command: ListCommand,
  body: Readonly<Record<string, unknown>>,
) => Promise<SubmitResult>;

/** The list writes' sender, holding the last write whose answer was lost. */
export function useHeldSend(client: OperationsClient): Send {
  const held = useRef<{ readonly act: string; readonly id: string } | null>(null);
  return async (command, body) => {
    const words = JSON.stringify([command, body]);
    const id = held.current?.act === words ? held.current.id : client.newOperationId();
    held.current = { act: words, id };
    const answer = await client.mutate(command, body, { operationId: id });
    if (settle(answer).kind !== 'unknown') held.current = null;
    return answer;
  };
}
