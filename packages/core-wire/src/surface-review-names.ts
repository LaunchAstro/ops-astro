// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' names (C35, #2011), part of `CommandName` (`command-names.ts`).
// In a file that imports nothing, as `surface-site-names.ts` is.

/**
 * A person or a delegated agent opens a review, asks a capture of a revision and pins a
 * comment on a spot of one (#2012); a worker claims the capture and lands it under its
 * lease; the review, with its revisions, captures and pins, and a landed picture are read.
 * A person files a client pin as a change request and a person decides it (C57, #2016).
 */
export type ReviewCommandName =
  | 'review.open'
  | 'review.capture'
  | 'review.capture_claim'
  | 'review.capture_land'
  | 'review.pin_comment'
  | 'review.propose_change'
  | 'review.decide_change'
  | 'review.read'
  | 'review.picture';
