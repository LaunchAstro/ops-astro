// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub: the activity ledger's face, before its tests pass.

import type { ReactElement } from 'react';

export interface LedgerEvent {
  readonly id: string;
  readonly at: string;
  readonly actorName: string;
  readonly operation: string;
  readonly task: { readonly key: string; readonly title: string | null };
}

export interface LedgerDay {
  readonly day: string;
  readonly events: readonly LedgerEvent[];
}

export interface LedgerProps {
  readonly days: readonly LedgerDay[];
  readonly earlier: boolean;
  readonly loading: boolean;
  readonly today: string;
  readonly timeZone: string;
  readonly taskHref: (key: string) => string;
  readonly onOpenTask: (key: string) => void;
  readonly onLoadEarlier: () => void;
}

export function Ledger(_props: LedgerProps): ReactElement | null {
  return null;
}
