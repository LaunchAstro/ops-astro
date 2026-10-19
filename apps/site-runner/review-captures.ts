// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's review captures (#2013, C35). Skeleton for the red proofs.

import type {
  CaptureOptions,
  CapturePool,
  PictureBrowser,
} from '../../packages/core-connectors/src/index.ts';
import type { BusinessId, CaptureWidth, Database } from '../../packages/core-records/src/index.ts';
import type { AgentCall } from './claims.ts';
import type { ConfiguredSite } from './configured.ts';

export const CAPTURE_PURPOSE = 'review_capture';

export type SizedBrowser = (width: CaptureWidth) => PictureBrowser;

export interface CaptureJob {
  readonly call: AgentCall;
  readonly db: Database;
  readonly business: BusinessId;
  readonly capture: CaptureOptions;
  readonly browserAt: SizedBrowser;
}

export interface Captured {
  readonly taskId: string;
  readonly outcome: string;
}

export const reviewPool = (_site: ConfiguredSite, _business: string): CapturePool => ({
  agencyPages: [],
  otherPages: [],
  closedPoolReviews: [],
});

export const reviewCaptures = (_job: CaptureJob) => async (): Promise<readonly Captured[]> =>
  await Promise.resolve([]);
