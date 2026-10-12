// SPDX-License-Identifier: AGPL-3.0-only
//
// The application's step-up and sign-in again (`use-money-command.ts`), around
// the whole shell, not the page alone: a money write in a dock panel (the
// Settings panel's planning cap) gets the same step-up as the page's. The
// password change (`session/password-change.ts`) is held beside them. Without
// a session there is nothing to step up or change, so all three are null.

import type { ReactElement, ReactNode } from 'react';
import {
  PasswordChangeContext,
  type PasswordChange,
  type PasswordChangeResult,
} from '../session/password-change.ts';
import type { StepUpResult } from '../session/step-up.ts';
import { SignInAgainContext, StepUpContext } from './use-money-command.ts';

export function StepUpProviders(props: {
  readonly on: boolean;
  readonly stepUp: (code: string) => Promise<StepUpResult>;
  readonly signInAgain: (password: string) => Promise<StepUpResult>;
  readonly changePassword?: (change: PasswordChange) => Promise<PasswordChangeResult>;
  readonly children: ReactNode;
}): ReactElement {
  const { on } = props;
  return (
    <StepUpContext.Provider value={on ? props.stepUp : null}>
      <SignInAgainContext.Provider value={on ? props.signInAgain : null}>
        <PasswordChangeContext.Provider value={on ? (props.changePassword ?? null) : null}>
          {props.children}
        </PasswordChangeContext.Provider>
      </SignInAgainContext.Provider>
    </StepUpContext.Provider>
  );
}
