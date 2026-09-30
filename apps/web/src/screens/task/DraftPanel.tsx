// SPDX-License-Identifier: AGPL-3.0-only
//
// The new-task draft (MP-4-13): a stub for the red run.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';

export interface DraftScope {
  readonly clientId: string | null;
  readonly from: string;
}

export interface DraftPanelProps {
  readonly client: OperationsClient;
  readonly storage: Storage | null;
  readonly person: string;
  readonly scope: DraftScope;
  readonly onCreated: (key: string) => void;
  readonly onClose: () => void;
}

export function DraftPanel(_props: DraftPanelProps): ReactElement {
  return <aside data-draft-panel />;
}
