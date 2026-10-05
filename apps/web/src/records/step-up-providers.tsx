// SPDX-License-Identifier: AGPL-3.0-only
//
// The application's step-up and sign-in again (`use-money-command.ts`), around
// the whole shell, not the page alone: a money write in a dock panel (the
// Settings panel's planning cap) gets the same step-up as the page's. Without
// a session there is nothing to step up, so both are null.

import type { ReactElement, ReactNode } from 'react';
import type { StepUpResult } from '../session/step-up.ts';
import { SignInAgainContext, StepUpContext } from './use-money-command.ts';

export function StepUpProviders(props: {
  readonly on: boolean;
  readonly stepUp: (code: string) => Promise<StepUpResult>;
  readonly signInAgain: (password: string) => Promise<StepUpResult>;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <StepUpContext.Provider value={props.on ? props.stepUp : null}>
      <SignInAgainContext.Provider value={props.on ? props.signInAgain : null}>
        {props.children}
      </SignInAgainContext.Provider>
    </StepUpContext.Provider>
  );
}
