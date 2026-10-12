// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentControls, Call } from './agent-pane.tsx';
/** C54's two answers at a budget stop, each on its owning command (AW-05). */
export function stopControls(
  props: { readonly recordId: string },
  busy: boolean,
  send: (call: Call) => void,
): Pick<AgentControls, 'topUpAtStop' | 'endAtStop'> {
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
): Pick<AgentControls, 'recordOutcome' | 'writeOff'> {
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
