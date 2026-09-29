// SPDX-License-Identifier: AGPL-3.0-only
//
// T3b: the reconciliation pass's lease-expiry phase. Not built on this commit.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { Classification } from './classifier.ts';

export async function sweepExpiredLeases(tx: TenantQuery): Promise<readonly Classification[]> {
  throw new Error(`sweepExpiredLeases: not built (${tx.businessId})`);
}
