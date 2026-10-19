// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' names (C35, #2011), part of `CommandName` (`command-names.ts`).
// In a file that imports nothing, as `surface-site-names.ts` is.

/**
 * A person or a delegated agent opens a review and asks a capture of a revision; a worker
 * claims the capture and lands it under its lease; the review and a landed picture are read.
 */
export type ReviewCommandName =
  | 'review.open'
  | 'review.capture'
  | 'review.capture_claim'
  | 'review.capture_land'
  | 'review.read'
  | 'review.picture';
