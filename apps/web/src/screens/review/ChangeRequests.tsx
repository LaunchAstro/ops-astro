// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement } from 'react';
import type { ChangeRequestView, LocalModelCode, PinView } from './change-requests.ts';
import type { DockClient } from './use-change-requests.ts';

export type DockLoad =
  | { readonly kind: 'loading' }
  | { readonly kind: 'refused'; readonly because: string }
  | {
      readonly kind: 'ready';
      readonly requests: readonly ChangeRequestView[];
      readonly pins: readonly PinView[];
    };

export interface ChangeRequestPanelProps {
  readonly load: DockLoad;
  readonly canDecide: boolean;
  readonly busy: string | null;
  readonly note: string | null;
  readonly agent: LocalModelCode;
  readonly onDecide: (changeRequestId: string, decision: 'approve' | 'refuse') => void;
  readonly onFile: (commentId: string, text: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}

export function ChangeRequestPanel(_props: ChangeRequestPanelProps): ReactElement {
  return <section />;
}

export function ChangeRequestDock(_props: {
  readonly client: DockClient;
  readonly reviewId: string;
  readonly onOpenTask: (taskId: string) => void;
}): ReactElement {
  return <section />;
}
