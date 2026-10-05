// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent pane's step-up hold (`agent-pane.tsx`): while its step-up prompt is
// open, the task page holds back its reread, so the reread cannot unmount the
// prompt mid-code. The hold is told as a refusal settles and let go as the
// prompt closes or the pane goes.

import { useEffect } from 'react';
import type { Settlement } from '../records/use-command.ts';

/** Holds the page under its reread while the step-up prompt is open, told as the refusal settles. */
export function useStepUpHold(
  props: { readonly onStepUp?: ((open: true | null) => void) | undefined },
  open: boolean,
): (settled: Settlement) => void {
  useEffect(() => {
    if (!open) props.onStepUp?.(null);
  });
  useEffect(() => () => props.onStepUp?.(null), []);
  return (settled) => {
    if (settled.kind === 'failed' && settled.refusal.code === 'STEP_UP_REQUIRED')
      props.onStepUp?.(true);
  };
}
