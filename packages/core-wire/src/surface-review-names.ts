// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' names (C35, #2011), part of `CommandName` (`command-names.ts`).
// In a file that imports nothing, as `surface-site-names.ts` is.

/**
 * A person or a delegated agent opens a review, asks a capture of a revision and pins a
 * comment on a spot of one (#2012); a worker claims the capture and lands it under its
 * lease, and carries the pins onto the new revision (#2075); the review, with its revisions,
 * captures and pins, and a landed picture are read; a client reads its own reviews in the
 * client projection, and the business's reviews are listed for the Reviews page.
 * A person files a client pin as a change request and a person decides it (C57, #2016); a
 * worker makes an approved one a task under its lease (#2117).
 * A person decides its latest revision and records Astra's review of it (#2014).
 */
export type ReviewCommandName =
  | 'review.open'
  | 'review.capture'
  | 'review.capture_claim'
  | 'review.capture_land'
  | 'review.carry_pins'
  | 'review.pin_comment'
  | 'review.propose_change'
  | 'review.decide_change'
  | 'review.make_change_task'
  | 'review.read'
  | 'review.list'
  | 'review.picture'
  | 'review.client_list'
  | 'review.decide'
  | 'review.record_astra_review';
