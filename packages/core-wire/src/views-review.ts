// SPDX-License-Identifier: AGPL-3.0-only
//
// What the review reads answer (C35, #2011): one review with its revisions and their captures
// by width, and what changed at each width since the revision before (#2105); one landed
// picture's bytes, base64; and the list of reviews the caller reads.

import type {
  CaptureWidth,
  ReviewPicture,
  ReviewSummary,
  ReviewView,
} from '../../core-records/src/index.ts';

export type { CaptureView as ReviewCaptureView } from '../../core-records/src/index.ts';

/**
 * What changed at one width between the previous revision's landed observation and this
 * one's: the one changed run of text (null when the text is the same) and each stylesheet
 * whose digest changed, came (no before) or went (no after), in address order.
 */
export interface WidthDifference {
  readonly width: CaptureWidth;
  readonly text: {
    readonly at: number;
    readonly removed: string;
    readonly added: string;
  } | null;
  readonly stylesheets: readonly {
    readonly address: string;
    readonly before: string | null;
    readonly after: string | null;
  }[];
}

export interface ReviewReadResult {
  readonly ok: true;
  /** `differences`: each width landed on both revisions; none for a first revision. */
  readonly review: ReviewView & { readonly differences: readonly WidthDifference[] };
}

export interface ReviewPictureResult {
  readonly ok: true;
  readonly picture: ReviewPicture;
}

/** The Reviews page's rows: the business's reviews the caller's grant covers. */
export interface ReviewListResult {
  readonly ok: true;
  readonly reviews: readonly ReviewSummary[];
}
