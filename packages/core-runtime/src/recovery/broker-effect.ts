// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-10: a broker call's drop on its run (scaffold; lands with its tests green).

import type { TenantQuery } from '../../../core-records/src/index.ts';

export interface CallDrop {
  readonly callId: string;
  readonly stepId: string;
  readonly operation: string;
  readonly cause: string | null;
  readonly fault: string | null;
  readonly providerCode: string | null;
  readonly unknownSince: string;
  readonly reconcileMode: string | null;
  readonly reached: 'accepted' | 'started';
  readonly afterEvent: number | null;
  readonly note: string | null;
  readonly outcome: string | null;
}

export async function readCallDrops(
  _tx: TenantQuery,
  _taskId: string,
): Promise<readonly CallDrop[]> {
  return await Promise.resolve([]);
}
