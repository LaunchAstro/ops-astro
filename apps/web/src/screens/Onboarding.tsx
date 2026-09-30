// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import type { OperationsClient } from '../operations/client.ts';

export function OnboardingScreen(_props: { readonly client: OperationsClient }): ReactElement {
  return <main data-onboarding />;
}
