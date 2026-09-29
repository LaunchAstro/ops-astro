// SPDX-License-Identifier: AGPL-3.0-only
//
// The token panel (MP-6-5, DA-08, DA-09, DS-TASK-9).

import type { ReactElement } from 'react';
import type { RunLineage } from '../../state/run-projection.ts';
import type { TaskLedger } from '../../state/token-ledger.ts';

export function TokenTracked(_props: {
  readonly ledger: TaskLedger | null;
  readonly lineages: readonly RunLineage[];
}): ReactElement | null {
  return null;
}
