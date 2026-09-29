// SPDX-License-Identifier: AGPL-3.0-only
//
// C2's two drawings: who else is on this page, in the app strip (CS-7.1), and
// who else is on this task and what they are changing (CS-7.36).

import type { ReactElement, ReactNode } from 'react';
import type { PresenceView } from '../data/presence.ts';

export function PagePresenceProvider(props: { readonly children: ReactNode }): ReactElement {
  return <>{props.children}</>;
}

export function useShowOnPage(_seen: readonly PresenceView[]): void {}

export function StripPresence(): ReactElement | null {
  return null;
}

export function TaskPresence(_props: {
  readonly seen: readonly PresenceView[];
}): ReactElement | null {
  return null;
}
