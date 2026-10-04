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
// A client, who may have no second factor, is refused naming `sign_in` (Q1):
// the prompt asks for their password instead, and a good one signs the tab in
// again (`session/sign-in-again.ts`, through `SignInAgainContext`) before the
// same one resend. The password passes through here to that call and is kept
// nowhere.
//
// Once, and only then: a resend refused again is drawn as any refusal is, with
// no second prompt queued behind it, and a session ended while the code or the
// password was checked (`sessionGeneration`) sends nothing. Nor does one
// cancelled while it was checked, whatever the check answers after.

import { createContext, useContext, useEffect, useRef, useState, type RefObject } from 'react';
import type { CallResult, OperationsClient } from '../operations/client.ts';
import { sessionGeneration } from '../session/token.ts';
import type { StepUpResult } from '../session/step-up.ts';
import { useCommand, type Command, type Settlement } from './use-command.ts';

/** The application's step-up of this tab's sign-in, or null where there is no session to step up. */
export const StepUpContext = createContext<((code: string) => Promise<StepUpResult>) | null>(null);

/** The application's password sign-in again, for a client's step-up, or null without a session. */
export const SignInAgainContext = createContext<
  ((password: string) => Promise<StepUpResult>) | null
>(null);

/** The prompt's state: open while a refused write waits on a code or a password. */
export interface StepUpAsk {
  readonly checking: boolean;
  /** The last code's or password's refusal, in the server's or the provider's words, or null. */
  readonly because: string | null;
  readonly submit: (code: string) => void;
  /** A password where the refusal named `sign_in` and the tab can sign in again; else a code. */
  readonly way: 'code' | 'password';
  readonly submitPassword: (password: string) => void;
  readonly cancel: () => void;
}

export type MoneyCommand = Omit<Command, 'run'> & {
  readonly run: <T>(
    work: (client: OperationsClient) => Promise<CallResult<T>>,
    then?: (settlement: Settlement<T>) => void,
  ) => void;
  /** The step-up prompt, or null when nothing waits on a code. */
  readonly stepUp: StepUpAsk | null;
  /** Drops the held write: the prompt closes, and a code that passed sends nothing. */
  readonly withdraw: () => void;
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
  /** Hold a refused write for a code or a password; null where nothing can step up. */
  readonly hold: ((send: Send, names: readonly string[]) => void) | null;
  readonly ask: StepUpAsk | null;
  readonly withdraw: () => void;
}

interface Asked {
  readonly send: Send;
  readonly way: StepUpAsk['way'];
}

/** The check in flight, and the one resend it earns once the new sign-in's client lands. */
function useResend(client: OperationsClient) {
  const latest = useRef(client);
  latest.current = client;
  const [checking, setChecking] = useState(false);
  const [because, setBecause] = useState<string | null>(null);
  const pending = useRef<Pending | null>(null);
  // Each cancel moves the round on: a check from an earlier round, however it
  // ends, holds and sends nothing.
  const round = useRef(0);
  // The resend waits for the client the application builds for the new sign-in.
  useEffect(() => {
    const held = pending.current;
    if (held !== null && client !== held.from) resend(pending, held, client);
  }, [client]);
  const check = (send: Send, attempt: () => Promise<StepUpResult>, passed: () => void): void => {
    if (checking) return;
    const held = { send, from: latest.current, generation: sessionGeneration() };
    const mine = round.current;
    setChecking(true);
    setBecause(null);
    void attempt().then((result) => {
      if (round.current !== mine) return result;
      setChecking(false);
      if (!result.ok) {
        setBecause(result.because);
        return result;
      }
      passed();
      if (latest.current === held.from) pending.current = held;
      else resend(pending, held, latest.current);
      return result;
    });
  };
  const withdraw = (): void => {
    round.current += 1;
    pending.current = null;
    setChecking(false);
  };
  return { checking, because, setBecause, check, withdraw };
}

/** The prompt: the write it holds, and which way it is met, a code or a password. */
function usePrompt(client: OperationsClient): Prompt {
  const stepUp = useContext(StepUpContext);
  const signInAgain = useContext(SignInAgainContext);
  const [asked, setAsked] = useState<Asked | null>(null);
  const { checking, because, setBecause, check, withdraw } = useResend(client);
  const open = (next: Asked | null): void => {
    setBecause(null);
    setAsked(next);
  };
  const drop = (): void => {
    withdraw();
    open(null);
  };
  const by = (way: StepUpAsk['way'], attempt: () => Promise<StepUpResult>): void => {
    if (asked?.way === way) check(asked.send, attempt, () => open(null));
  };
  const ask: StepUpAsk = {
    checking,
    because,
    way: asked?.way ?? 'code',
    submit: (code) => {
      if (stepUp !== null) by('code', async () => await stepUp(code));
    },
    submitPassword: (password) => {
      if (signInAgain !== null) by('password', async () => await signInAgain(password));
    },
    cancel: drop,
  };
  const hold = (send: Send, names: readonly string[]): void => {
    const way = names.includes('sign_in') && signInAgain !== null ? 'password' : 'code';
    if (way === 'password' || stepUp !== null) open({ send, way });
  };
  const none = stepUp === null && signInAgain === null;
  return { hold: none ? null : hold, ask: asked === null ? null : ask, withdraw: drop };
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
        if (refusal?.code === 'STEP_UP_REQUIRED') prompt.hold?.(send, refusal.names);
        then?.(settlement);
      },
    );
  };
  const { run: _plain, ...rest } = command;
  return { ...rest, run, stepUp: prompt.ask, withdraw: prompt.withdraw };
}
