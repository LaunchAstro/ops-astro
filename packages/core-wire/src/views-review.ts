// SPDX-License-Identifier: AGPL-3.0-only
//
// What the review reads answer (C35, #2011): one review with its revisions and their captures
// by width, and one landed picture's bytes, base64.

import type { Anchor, ReviewPicture, ReviewView } from '../../core-records/src/index.ts';

export type { CaptureView as ReviewCaptureView } from '../../core-records/src/index.ts';

export interface ReviewReadResult {
  readonly ok: true;
  readonly review: ReviewView;
}

export interface ReviewPictureResult {
  readonly ok: true;
  readonly picture: ReviewPicture;
}

/** A comment's pin fields; a type alias, so the comment it joins is still a record. */
export type CommentPin = {
  /** A pin's spot on a review's capture (C35); absent on a comment that is no pin. */
  readonly anchor?: Anchor;
};
