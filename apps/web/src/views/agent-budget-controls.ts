// SPDX-License-Identifier: AGPL-3.0-only
import type { RecordedOutcome } from '@launchastro/ui';
import type { OperationsClient } from '../operations/client.ts';

/** One write, handed the client of the sign-in it goes on. */
export type Call = (client: OperationsClient) => ReturnType<OperationsClient['mutate']>;

/** The two answers at a budget stop. */
export interface StopControls {
  readonly topUpAtStop: (
    runId: string,
    askId: string,
    amountMinor: number,
    currency: string,
  ) => void;
  readonly endAtStop: (runId: string, askId: string) => void;
}

/** The two acts on an unknown effect. */
export interface UnknownControls {
  readonly recordOutcome: (attemptId: string, outcome: RecordedOutcome) => void;
  readonly writeOff: (attemptId: string, amountMinor: number, reason: string) => void;
}

/** C54's two answers at a budget stop, each on its owning command (AW-05). */
export function stopControls(
  props: { readonly recordId: string },
  busy: boolean,
  send: (call: Call) => void,
): StopControls {
  return {
    topUpAtStop: (runId, askId, amountMinor, currency) => {
      if (busy) return;
      send((client) =>
        client.mutate('run.top_up', {
          recordId: props.recordId,
          runId,
          askId,
          amountMinor,
          currency,
        }),
      );
    },
    endAtStop: (runId, askId) => {
      if (busy) return;
      send((client) =>
        client.mutate('run.end_at_budget_stop', { recordId: props.recordId, runId, askId }),
      );
    },
  };
}

/** C54's two acts on an unknown effect, each on its owning command (T3d1, T3c). */
export function unknownControls(
  props: { readonly recordId: string },
  busy: boolean,
  send: (call: Call) => void,
): UnknownControls {
  return {
    recordOutcome: (attemptId, outcome) => {
      if (busy) return;
      send((client) =>
        client.mutate('budget.record_outcome', {
          recordId: props.recordId,
          attemptId,
          outcome,
        }),
      );
    },
    writeOff: (attemptId, amountMinor, reason) => {
      if (busy) return;
      send((client) =>
        client.mutate('budget.write_off', {
          recordId: props.recordId,
          attemptId,
          amountMinor,
          reason,
        }),
      );
    },
  };
}
