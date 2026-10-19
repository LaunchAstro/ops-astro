// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' names (C35, #2011), part of `CommandName` (`command-names.ts`).
// In a file that imports nothing, as `surface-site-names.ts` is.

/**
 * A person or a delegated agent opens a review and asks a capture of a revision; the review
 * is read with its revisions and captures.
 */
export type ReviewCommandName = 'review.open' | 'review.capture' | 'review.read';
