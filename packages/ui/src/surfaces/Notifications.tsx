// SPDX-License-Identifier: AGPL-3.0-only
//
// Stub: the Notifications panel, `/inbox/` and the bell, before their tests pass.

import type { ReactElement } from 'react';
import type { InboxGroupRef, InboxItem } from '../state/inbox.ts';

export interface OpenHow {
  readonly beside: boolean;
}

export interface NotificationsProps {
  readonly items: readonly InboxItem[];
  readonly owedCount: number;
  readonly groupOf: (item: InboxItem) => InboxGroupRef;
  readonly taskHref: (key: string) => string;
  readonly onOpenTask: (key: string, how: OpenHow) => void;
  readonly onOpenClient: (key: string, how: OpenHow) => void;
}

export function NotificationsPanel(_props: NotificationsProps): ReactElement | null {
  return null;
}

export function InboxPage(_props: NotificationsProps): ReactElement | null {
  return null;
}

export function Bell(_props: {
  readonly owedCount: number;
  readonly onOpen: () => void;
}): ReactElement | null {
  return null;
}
