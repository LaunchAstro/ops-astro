// SPDX-License-Identifier: AGPL-3.0-only
//
// Clearing (INB-1c). Shape only on the red commit: the tests name these two.

import type { TenantQuery } from '../tenancy/database.ts';

export async function clearDecision(
  _tx: TenantQuery,
  _decided: { readonly gateId: string; readonly decisionId: string },
): Promise<number> {
  throw new Error('clearDecision: not built yet (INB-1c)');
}

export async function withdrawEndedGates(_tx: TenantQuery, _taskId: string): Promise<number> {
  throw new Error('withdrawEndedGates: not built yet (INB-1c)');
}
