// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' names (C35, #2011), part of `CommandName` (`command-names.ts`).
// In a file that imports nothing, as `surface-site-names.ts` is.

/**
 * A person or a delegated agent opens a review, asks a capture of a revision and pins a
 * comment on a spot of one (#2012); the review is read with its revisions, captures and pins.
 */
export type ReviewCommandName =
  'review.open' | 'review.capture' | 'review.pin_comment' | 'review.read';
