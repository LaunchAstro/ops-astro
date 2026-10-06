// SPDX-License-Identifier: AGPL-3.0-only
//
// The Agent pane's step-up hold (`agent-pane.tsx`): while its step-up prompt is
// open, the task page holds back its reread, so the reread cannot unmount the
// prompt mid-code. The hold is told as a refusal settles and let go as the
// prompt closes or the pane goes. A decision held for a code is withdrawn once
// the task's decide controls close, so no code sends it after a refusal said
// none would be asked again, nor one that passed while the new sign-in's
// client is yet to land: the withdraw runs as the page lays out, before any
// resend. Any other command's prompt stays.

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Settlement } from '../records/use-command.ts';
import type { MoneyCommand } from '../records/use-money-command.ts';

/** Holds the page under its reread while the step-up prompt is open, told as the refusal settles. */
export function useStepUpHold(
  props: {
    readonly onStepUp?: ((open: true | null) => void) | undefined;
    readonly note: { readonly closed: boolean } | null;
  },
  { stepUp, withdraw }: Pick<MoneyCommand, 'stepUp' | 'withdraw'>,
): (settled: Settlement, decision?: boolean) => void {
  const deciding = useRef(false);
  useLayoutEffect(() => {
    if (!deciding.current || props.note?.closed !== true) return;
    deciding.current = false;
    withdraw();
  });
  useEffect(() => {
    if (stepUp === null) props.onStepUp?.(null);
  });
  useEffect(() => () => props.onStepUp?.(null), []);
  return (settled, decision = false) => {
    deciding.current = decision;
    if (settled.kind === 'failed' && settled.refusal.code === 'STEP_UP_REQUIRED')
      props.onStepUp?.(true);
  };
}
