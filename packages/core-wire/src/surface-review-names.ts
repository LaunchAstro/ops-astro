// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' names (C35, #2011), part of `CommandName` (`command-names.ts`).
// In a file that imports nothing, as `surface-site-names.ts` is.

/**
 * A person, or an agent on that person's credential, opens a review, asks a capture of a
 * revision and pins a comment on a spot of one (#2012); a worker claims the capture and lands
 * it under its lease, and carries the pins onto the new revision (#2075); the review, with its
 * revisions, captures and pins, and a landed picture are read.
 */
export type ReviewCommandName =
  | 'review.open'
  | 'review.capture'
  | 'review.capture_claim'
  | 'review.capture_land'
  | 'review.carry_pins'
  | 'review.pin_comment'
  | 'review.read'
  | 'review.picture';
