// SPDX-License-Identifier: AGPL-3.0-only
//
// The Ad hoc and Client access ticks (MP-4-10). A typed stub until the ticks
// are built.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';

export interface TicksTask {
  readonly id: string;
  readonly revision: number;
  readonly adHoc: boolean;
  readonly clientAccess: boolean;
}

export function HandlingTicks(_props: {
  readonly client: OperationsClient;
  readonly task: TicksTask;
  readonly onChanged: () => void;
}): ReactElement {
  return <div />;
}
