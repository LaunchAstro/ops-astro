// SPDX-License-Identifier: AGPL-3.0-only
//
// A money write refused `STEP_UP_REQUIRED` and held for its code (C59), with
// the client and the step-up's answer in the test's hands: which client the
// page renders, and when, and when the code's check returns. The stand-in API
// refuses every session but `sid-new`, the one the step-up answers, and
// records the session each budget top-up went out on.

import { act, type ReactElement } from 'react';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  StepUpContext,
  useMoneyCommand,
  type MoneyCommand,
} from '../../apps/web/src/records/use-money-command.ts';
import type { StepUpResult } from '../../apps/web/src/session/step-up.ts';
import { StepUpPrompt } from '../../apps/web/src/views/step-up-prompt.tsx';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { json, settle } from './mp-2-1-support.tsx';

export const STEPPED_UP = 'sid-new';

const TOP_UP = { recordId: 'task-1', amountMinor: 1_000, fromMaximumMinor: 250_000 };

function Probe(props: {
  readonly client: OperationsClient;
  readonly expose: (money: MoneyCommand) => void;
}): ReactElement | null {
  const money = useMoneyCommand(props.client);
  props.expose(money);
  return money.stepUp === null ? null : <StepUpPrompt ask={money.stepUp} />;
}

export interface ResendProbe {
  readonly view: Mounted;
  /** The session each top-up went out on, in order. */
  readonly sent: readonly (string | null)[];
  /** Renders the page's client for `sessionId`, a new object each time. */
  readonly renderOn: (sessionId: string) => Promise<void>;
  /** The top-up, sent on the client rendered last. */
  readonly topUp: () => Promise<void>;
  /** Types a code into the prompt and confirms it: the check starts and waits. */
  readonly confirm: () => Promise<void>;
  /** The check returns: the code passed, and the step-up named `sid-new`. */
  readonly pass: () => Promise<void>;
  readonly cancel: () => Promise<void>;
}

/** The stand-in API: refuses every session but the stepped-up one, and records each. */
function stepUpApi() {
  const sent: (string | null)[] = [];
  const fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const session = new Headers(init?.headers).get(SESSION_HEADER);
    sent.push(session);
    return Promise.resolve(
      session === STEPPED_UP
        ? json({ recordId: null, revision: null, detail: { state: 'applied' } })
        : json({ refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: [] }, 403),
    );
  }) as unknown as typeof globalThis.fetch;
  const clientOn = (sessionId: string) =>
    new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, sessionId, fetch });
  return { sent, clientOn };
}

const PROMPT = '[data-step-up="prompt"]';

export async function openResendProbe(): Promise<ResendProbe> {
  const { sent, clientOn } = stepUpApi();
  const checked: { pass?: (result: StepUpResult) => void } = {};
  const stepUp = (): Promise<StepUpResult> =>
    new Promise<StepUpResult>((resolve) => {
      checked.pass = resolve;
    });
  let money: MoneyCommand | undefined;
  const tree = (client: OperationsClient): ReactElement => (
    <StepUpContext.Provider value={stepUp}>
      <Probe client={client} expose={(next) => (money = next)} />
    </StepUpContext.Provider>
  );
  const view = await mount(tree(clientOn('sid-old')));
  return {
    view,
    sent,
    renderOn: async (sessionId) => {
      await view.render(tree(clientOn(sessionId)));
      await settle();
    },
    topUp: async () => {
      await act(() => {
        money?.run((to) => to.mutate('budget.top_up', TOP_UP, { operationId: 'operation-1' }));
      });
      await settle();
    },
    confirm: async () => {
      await view.type(`${PROMPT} [data-step-up="code"]`, '123456');
      await view.click(`${PROMPT} [data-step-up="confirm"]`);
    },
    pass: async () => {
      await act(async () => {
        checked.pass?.({ ok: true, sessionId: STEPPED_UP });
        await Promise.resolve();
      });
      await settle();
    },
    cancel: async () => await view.click(`${PROMPT} [data-step-up="cancel"]`),
  };
}
