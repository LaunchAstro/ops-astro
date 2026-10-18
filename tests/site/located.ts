// SPDX-License-Identifier: AGPL-3.0-only
//
// Seeding for tests that start from a pinned correction (#1693): the request
// stores it `locating`, and these pins stand in for the site runner's, in the
// forms the storage requires. The trigger allows exactly this move, once.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';

/** Pins in the stored forms: a 40-hex commit and `sha256:` digests. */
export const TEST_PIN: {
  readonly baseRevision: string;
  readonly preImageDigest: string;
  readonly versionDigest: string;
} = {
  baseRevision: `c0ffee${'0'.repeat(34)}`,
  preImageDigest: `sha256:${'ab'.repeat(32)}`,
  versionDigest: `sha256:${'cd'.repeat(32)}`,
};

export interface TestPin {
  readonly baseRevision?: string;
  readonly preImageDigest?: string;
  readonly versionDigest?: string;
  /** Stamped checked now (the default), or left unchecked. */
  readonly verified?: boolean;
}

/** Pin a `locating` correction as the runner would; its new version id. */
export async function pinAsRunner(
  tx: TenantQuery,
  id: string,
  pin: TestPin = {},
): Promise<{ readonly versionId: string }> {
  const versionId = randomUUID();
  const rows = await tx.query<{ readonly id: string }>(
    `update public.live_corrections
        set pre_image_digest = $3, base_revision = $4, version_id = $5::uuid,
            version_digest = $6, located_at = clock_timestamp(),
            verified_at = case when $7 then clock_timestamp() end, state = 'requested'
      where business_id = $1 and id = $2 and state = 'locating'
      returning id`,
    [
      tx.businessId,
      id,
      pin.preImageDigest ?? TEST_PIN.preImageDigest,
      pin.baseRevision ?? TEST_PIN.baseRevision,
      versionId,
      pin.versionDigest ?? TEST_PIN.versionDigest,
      pin.verified ?? true,
    ],
  );
  if (rows.length === 0) throw new Error('pinAsRunner: the correction is not locating');
  return { versionId };
}
