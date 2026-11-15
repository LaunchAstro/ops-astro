// SPDX-License-Identifier: AGPL-3.0-only
//
// The review section's rows of "Duplicate without contents" (`duplicate-kinds.ts`): a review,
// its captures, pins, carries, change requests and decisions are history of the old task's
// review, so a duplicate carries none of them; each names what its shell case would plant.
// Kept apart so the declaration keeps under its line cap as the section grows. A harness.

export const REVIEW_DECLARED: Readonly<
  Record<string, { readonly carry: 'not carried'; readonly plant: string }>
> = {
  // C35: a review is opened at the old task's client and its bound page; a duplicate carries none.
  'review.open': { carry: 'not carried', plant: 'needs a bound site page' },
  'review.capture': { carry: 'not carried', plant: 'needs a review revision' },
  'review.capture_claim': { carry: 'not carried', plant: 'needs a requested capture and a lease' },
  'review.capture_land': { carry: 'not carried', plant: 'needs a claimed capture' },
  'review.pin_comment': { carry: 'not carried', plant: 'needs a captured review revision' },
  // C57: a change request is filed from a client pin and decided; a duplicate carries none.
  'review.propose_change': { carry: 'not carried', plant: 'needs a client pin' },
  'review.decide_change': { carry: 'not carried', plant: 'needs a proposed change request' },
  // C35-X: a pin's carry is history of the old task's review; a duplicate carries none.
  'review.carry_pins': { carry: 'not carried', plant: 'needs a landed revision under a lease' },
  'review.make_change_task': { carry: 'not carried', plant: 'needs an approved change request' },
  'review.decide': { carry: 'not carried', plant: 'needs a review revision' },
  'review.record_astra_review': { carry: 'not carried', plant: 'needs a review revision' },
};
