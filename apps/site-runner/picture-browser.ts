// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's picture browser (#2013, C35). Skeleton for the red proofs.

import type { PictureBrowser } from '../../packages/core-connectors/src/index.ts';
import type { CaptureWidth } from '../../packages/core-records/src/index.ts';

export const chromiumAt =
  (_width: CaptureWidth): PictureBrowser =>
  async () =>
    await Promise.reject(new Error('not built'));
