// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' operands (C35, #2011), spread into `WRITE_OPERANDS` in
// `write-operands.ts`, whose type checks every operand. Each is checked by value in its
// handler (`review-commands.ts`, `review-captures.ts`).

export const REVIEW_OPERANDS = {
  'review.open': { taskId: 'any', pageUrl: 'any', path: 'any', sourceRevision: 'any' },
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
  },
  // #2018: a closed review of the capture pool, recorded by the operator (`pool-review-write.ts`).
  'operations.record_capture_pool_review': {
    review: 'any',
    poolVersion: 'any',
    evidence: 'any',
    company: 'any',
  },
} as const;
