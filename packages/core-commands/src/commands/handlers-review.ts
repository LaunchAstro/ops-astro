// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's handlers (#2011) and C57's (#2016), spread into `handlers.ts`'s table, which is at its line cap.

import type { Handler } from './handler-types.ts';
import { askReviewCapture, openReview } from './review-commands.ts';
import { claimCaptureAsPerson, landCaptureAsPerson } from './review-captures.ts';
import { carryPinsAsPerson } from './review-carry.ts';
import { pinComment } from './review-pin.ts';
import { decideChange, proposeChange } from './review-change.ts';
import { makeChangeTaskAsPerson } from './review-change-task.ts';
import { decideReview, recordAstraReview } from './review-decide.ts';

type ReviewWrite =
  | 'review.open'
  | 'review.capture'
  | 'review.capture_claim'
  | 'review.capture_land'
  | 'review.carry_pins'
  | 'review.pin_comment'
  | 'review.propose_change'
  | 'review.decide_change'
  | 'review.make_change_task'
  | 'review.decide'
  | 'review.record_astra_review';

export const REVIEW_HANDLERS: { readonly [K in ReviewWrite]: Handler<K> } = {
  'review.open': openReview,
  'review.capture': askReviewCapture,
  'review.capture_claim': claimCaptureAsPerson,
  'review.capture_land': landCaptureAsPerson,
  'review.carry_pins': carryPinsAsPerson,
  'review.pin_comment': pinComment,
  'review.propose_change': proposeChange,
  'review.decide_change': decideChange,
  'review.make_change_task': makeChangeTaskAsPerson,
  'review.decide': decideReview,
  'review.record_astra_review': recordAstraReview,
};
