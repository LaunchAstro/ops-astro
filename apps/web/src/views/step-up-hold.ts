// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent pane's step-up hold (`agent-pane.tsx`): while its step-up prompt is
// open, the task page holds back its reread, so the reread cannot unmount the
// prompt mid-code. The hold is told as a refusal settles and let go as the
// prompt closes or the pane goes. A prompt a decision opened is withdrawn once
// the task's decide controls close, so the code sends no decision after a
// refusal said none would be asked again; any other command's prompt stays.

import { useEffect, useRef } from 'react';
import type { Settlement } from '../records/use-command.ts';
import type { StepUpAsk } from '../records/use-money-command.ts';

/** Holds the page under its reread while the step-up prompt is open, told as the refusal settles. */
export function useStepUpHold(
  props: {
    readonly onStepUp?: ((open: true | null) => void) | undefined;
    readonly note: { readonly closed: boolean } | null;
  },
  stepUp: StepUpAsk | null,
): (settled: Settlement, decision?: boolean) => void {
  const deciding = useRef(false);
  useEffect(() => {
    if (stepUp !== null && deciding.current && props.note?.closed === true) stepUp.cancel();
    else if (stepUp === null) props.onStepUp?.(null);
  });
  useEffect(() => () => props.onStepUp?.(null), []);
  return (settled, decision = false) => {
    deciding.current = decision;
    if (settled.kind === 'failed' && settled.refusal.code === 'STEP_UP_REQUIRED')
      props.onStepUp?.(true);
  };
}
