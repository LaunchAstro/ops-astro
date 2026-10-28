// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's handlers (#2011), spread into `handlers.ts`'s table, which is at its line cap.

import type { Handler } from './handler-types.ts';
import { askReviewCapture, openReview } from './review-commands.ts';
import { claimCaptureAsPerson, landCaptureAsPerson } from './review-captures.ts';

type ReviewWrite =
  'review.open' | 'review.capture' | 'review.capture_claim' | 'review.capture_land';

export const REVIEW_HANDLERS: { readonly [K in ReviewWrite]: Handler<K> } = {
  'review.open': openReview,
  'review.capture': askReviewCapture,
  'review.capture_claim': claimCaptureAsPerson,
  'review.capture_land': landCaptureAsPerson,
};
