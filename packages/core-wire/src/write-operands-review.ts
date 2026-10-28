// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' operands (C35, #2011), spread into `WRITE_OPERANDS` in
// `write-operands.ts`, whose type checks every operand. Each is checked by value in its
// handler (`review-commands.ts`, `review-captures.ts`).

export const REVIEW_OPERANDS = {
  'review.open': {
    taskId: 'any',
    pageUrl: 'any',
    path: 'any',
    sourceRevision: 'any',
    correctionId: 'any',
  },
  'review.capture': { revisionId: 'any' },
  'review.capture_claim': { leaseId: 'any', fence: 'any', revisionId: 'any' },
  'review.capture_land': {
    leaseId: 'any',
    fence: 'any',
    revisionId: 'any',
    width: 'any',
    picture: 'any',
    observation: 'any',
  },
  'review.carry_pins': { leaseId: 'any', fence: 'any', revisionId: 'any' },
  'review.pin_comment': {
    revisionId: 'any',
    width: 'any',
    selector: 'any',
    body: 'any',
    audience: 'any',
    liveViewport: 'any',
  },
  'review.propose_change': { commentId: 'any', text: 'any' },
  'review.decide_change': { changeRequestId: 'any', decision: 'any' },
  'review.make_change_task': { leaseId: 'any', fence: 'any', changeRequestId: 'any' },
  'review.decide': { reviewId: 'any', digest: 'any', response: 'any' },
  'review.record_astra_review': { reviewId: 'any', digest: 'any', verdict: 'any', review: 'any' },
} as const;
