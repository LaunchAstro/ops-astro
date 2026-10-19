// SPDX-License-Identifier: AGPL-3.0-only
//
// The review reads' operands and answers (C35, #2011), on their own as
// `correction-read-operands.ts` is, so the read requests take them without importing
// the reads' module.

import type { ReviewReadResult } from '../../../core-wire/src/index.ts';

/** One review with its revisions and captures. */
export interface ReviewReadOperands {
  readonly 'review.read': { readonly reviewId: string };
}

export type ReviewReadsResult = ReviewReadResult;
