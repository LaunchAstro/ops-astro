// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-08: the reviewed output. A signature stub for the red commit: nothing is
// marked and nothing reads as reviewed, so dispatch still lets a plan accept
// release an effect.

import type { TenantQuery } from '../../core-records/src/index.ts';

export interface ReviewedOutputMark {
  readonly versionId: string;
  readonly lineageId: string;
  readonly leaseId: string;
}

export async function markReviewedOutput(tx: TenantQuery, mark: ReviewedOutputMark): Promise<void> {
  await Promise.resolve([tx, mark]);
}

export async function isReviewedOutput(tx: TenantQuery, versionId: string): Promise<boolean> {
  return await Promise.resolve([tx, versionId].length === 0);
}
