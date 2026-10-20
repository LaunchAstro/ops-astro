// SPDX-License-Identifier: AGPL-3.0-only
//
// The review reads' operands and answers (C35, #2011), on their own as
// `correction-read-operands.ts` is, so the read requests take them without importing
// the reads' module.

import type {
  ClientReviewListResult,
  ReviewListResult,
  ReviewPictureResult,
  ReviewReadResult,
} from '../../../core-wire/src/index.ts';

/**
 * One review with its revisions and captures; one landed picture; a client's own reviews; the
 * reviews the caller reads.
 */
export interface ReviewReadOperands {
  readonly 'review.read': { readonly reviewId: string };
  readonly 'review.picture': { readonly pictureId: string };
  readonly 'review.client_list': Readonly<Record<never, never>>;
  readonly 'review.list': Readonly<Record<never, never>>;
}

export type ReviewReadsResult =
  ReviewReadResult | ReviewPictureResult | ClientReviewListResult | ReviewListResult;
