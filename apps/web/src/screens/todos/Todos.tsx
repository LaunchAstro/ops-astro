// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects dock panel, the reader's own to-dos (MP-7-1): a stub for the red run.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import type { TaskPanelHost } from '../../screen-registry.tsx';

export interface TodosScreenProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly taskPanel?: TaskPanelHost;
  /** The clock the business day is read on; the real one unless a test fixes it. */
  readonly now?: () => Date;
}

export function TodosScreen(_props: TodosScreenProps): ReactElement {
  return <div />;
}
