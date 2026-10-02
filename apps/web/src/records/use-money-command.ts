// SPDX-License-Identifier: AGPL-3.0-only
//
// `useCommand` for a money write (C59): the same one write in flight and the
// same settlement, and when the server answers `STEP_UP_REQUIRED` a prompt for
// the authenticator code. A good code moves the tab to a stepped-up sign-in
// (`session/step-up.ts`, through the application's `StepUpContext`), and the
// write goes once more, through the client the application built for that
// sign-in: the work is handed a client rather than closing over one, and the
// latest client is held here for the resend.
//
// Once, and only then: a resend refused again is drawn as any refusal is, with
// no second prompt queued behind it, and a session ended while the code was
// checked (`sessionGeneration`) sends nothing.

import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react';
import type { CallResult, OperationsClient } from '../operations/client.ts';
import { sessionGeneration } from '../session/token.ts';
import type { StepUpResult } from '../session/step-up.ts';
import { useCommand, type Command, type Settlement } from './use-command.ts';

/** The application's step-up of this tab's sign-in, or null where there is no session to step up. */
export const StepUpContext = createContext<((code: string) => Promise<StepUpResult>) | null>(null);

/** The prompt's state: open while a refused write waits on a code. */
export interface StepUpAsk {
  readonly checking: boolean;
  /** The last code's refusal, in the server's words, or null. */
  readonly because: string | null;
  readonly submit: (code: string) => void;
  readonly cancel: () => void;
}

export type MoneyCommand = Omit<Command, 'run'> & {
  readonly run: <T>(
    work: (client: OperationsClient) => Promise<CallResult<T>>,
    then?: (settlement: Settlement<T>) => void,
  ) => void;
  /** The step-up prompt, or null when nothing waits on a code. */
  readonly stepUp: StepUpAsk | null;
};

type Send = (client: OperationsClient) => void;

interface Pending {
  readonly send: Send;
  readonly from: OperationsClient;
  readonly generation: number;
}

/** Sent once, on the new sign-in's client, only while the session is the one that asked. */
function resend(pending: RefObject<Pending | null>, held: Pending, next: OperationsClient): void {
  pending.current = null;
  if (held.generation !== sessionGeneration()) return;
  if (next.businessKey !== held.from.businessKey) return;
  held.send(next);
}

interface Prompt {
  /** Hold a refused write for the code; null where nothing can step up. */
  readonly hold: ((send: Send) => void) | null;
  readonly ask: StepUpAsk | null;
}

/** The prompt: the write it holds, the code's check, and the resend once the new client lands. */
function usePrompt(client: OperationsClient): Prompt {
  const stepUp = useContext(StepUpContext);
  const latest = useRef(client);
  latest.current = client;
  const [asked, setAsked] = useState<Send | null>(null);
  const [checking, setChecking] = useState(false);
  const [because, setBecause] = useState<string | null>(null);
  const pending = useRef<Pending | null>(null);
  // The resend waits for the client the application builds for the new sign-in.
  useEffect(() => {
    const held = pending.current;
    if (held !== null && client !== held.from) resend(pending, held, client);
  }, [client]);
  const open = (send: Send | null): void => {
    setBecause(null);
    setAsked(() => send);
  };
  const submit = (code: string): void => {
    if (asked === null || stepUp === null || checking) return;
    const held = { send: asked, from: latest.current, generation: sessionGeneration() };
    setChecking(true);
    setBecause(null);
    void stepUp(code).then((result) => {
      setChecking(false);
      if (!result.ok) {
        setBecause(result.because);
        return result;
      }
      open(null);
      if (latest.current === held.from) pending.current = held;
      else resend(pending, held, latest.current);
      return result;
    });
  };
  const ask = { checking, because, submit, cancel: () => open(null) };
  return { hold: stepUp === null ? null : open, ask: asked === null ? null : ask };
}

export function useMoneyCommand(client: OperationsClient): MoneyCommand {
  const command = useCommand();
  const prompt = usePrompt(client);
  const latest = useRef({ client, command });
  latest.current = { client, command };
  const run: MoneyCommand['run'] = (work, then) => {
    prompt.ask?.cancel();
    const send: Send = (to) => {
      latest.current.command.run(() => work(to), then);
    };
    command.run(
      () => work(latest.current.client),
      (settlement) => {
        const refusal = settlement.kind === 'failed' ? settlement.refusal : null;
        if (refusal?.code === 'STEP_UP_REQUIRED') prompt.hold?.(send);
        then?.(settlement);
      },
    );
  };
  const { run: _plain, ...rest } = command;
  return { ...rest, run, stepUp: prompt.ask };
}
