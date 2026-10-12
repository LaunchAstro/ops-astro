// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's budget top-up (T2e), held above the read. A top-up is a
// money write (C59): refused `STEP_UP_REQUIRED`, it waits on a code, and the
// prompt and the write it holds must outlive a reread, which unmounts the
// control (`record-state.tsx`). It is also one attempt until its answer is
// known: a lost answer keeps it, so the next press sends the same operation
// id with the same figures, and a top-up that was made is answered as itself
// rather than made again under a new id. Both are held here, once per task
// under one grant (the page is keyed on both), and end on a known answer, on
// Cancel, or with the page.

import { createContext, use, useState, type ReactElement, type ReactNode } from 'react';
import type { CommandOutcome, OperationsClient } from '../operations/client.ts';
import type { Settlement } from '../records/use-command.ts';
import { useMoneyCommand, type MoneyCommand } from '../records/use-money-command.ts';

/** One top-up: its identity and its figures, sent as they are each time. */
export interface TopUpAttempt {
  readonly operationId: string;
  readonly payload: {
    readonly recordId: string;
    readonly amountMinor: number;
    readonly fromMaximumMinor: number;
  };
}

export interface TopUpHold {
  readonly command: MoneyCommand;
  /** The attempt whose answer was lost, which the next press sends again; else null. */
  readonly lost: TopUpAttempt | null;
  readonly send: (
    attempt: TopUpAttempt,
    then: (settled: Settlement<CommandOutcome>) => void,
  ) => void;
}

const TopUpHoldContext = createContext<TopUpHold | null>(null);

function useTopUpHold(client: OperationsClient): TopUpHold {
  const command = useMoneyCommand(client);
  const [lost, setLost] = useState<TopUpAttempt | null>(null);
  const send: TopUpHold['send'] = (attempt, then) => {
    command.run(
      (to) => to.mutate('budget.top_up', attempt.payload, { operationId: attempt.operationId }),
      (settled) => {
        setLost(settled.kind === 'unknown' ? attempt : null);
        then(settled);
      },
    );
  };
  return { command, lost, send };
}

/** The page's top-up hold, for the top-up control anywhere under it. */
export function TopUpScope(props: {
  readonly client: OperationsClient;
  readonly children: ReactNode;
}): ReactElement {
  return <TopUpHoldContext value={useTopUpHold(props.client)}>{props.children}</TopUpHoldContext>;
}

/** The page's hold, or null outside one. */
export function usePageTopUp(): TopUpHold | null {
  return use(TopUpHoldContext);
}

/** The page's hold where there is one, else this control's own. */
export function useTopUp(client: OperationsClient): TopUpHold {
  const own = useTopUpHold(client);
  return usePageTopUp() ?? own;
}
