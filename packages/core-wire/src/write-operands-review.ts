// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' operands (C35, #2011), spread into `WRITE_OPERANDS` in
// `write-operands.ts`, whose type checks every operand. Each is checked by value in its
// handler (`review-commands.ts`).

export const REVIEW_OPERANDS = {
  'review.open': { taskId: 'any', pageUrl: 'any', path: 'any', sourceRevision: 'any' },
  'review.capture': { revisionId: 'any' },
} as const;
