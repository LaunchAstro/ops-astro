// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-6 stub, replaced by the change that follows the red tests.

import type { ReactElement, ReactNode } from 'react';

export type Provenance = 'real' | 'mock' | 'absent';

export interface NotConnectedProps {
  readonly source: string;
  readonly reason: string;
  readonly action?: ReactNode;
}

export interface UnavailableProps {
  readonly feature: string;
  readonly label: string;
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'text' | undefined;
}

export type Freshness =
  | { readonly state: 'live'; readonly age: string }
  | { readonly state: 'catching-up'; readonly lastRead: string }
  | { readonly state: 'offline'; readonly lastRead: string }
  | {
      readonly state: 'source-behind';
      readonly source: string;
      readonly lastGood: string;
      readonly href: string;
    }
  | { readonly state: 'frozen'; readonly at: string };

export function SourceRegion(_props: {
  readonly provenance: Provenance;
  readonly children: ReactNode;
}): ReactElement | null {
  return null;
}

export function NotConnected(_props: NotConnectedProps): ReactElement | null {
  return null;
}

export function Unavailable(_props: UnavailableProps): ReactElement | null {
  return null;
}

export function FreshnessMarker(_props: { readonly freshness: Freshness }): ReactElement | null {
  return null;
}
