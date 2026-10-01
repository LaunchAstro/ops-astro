// SPDX-License-Identifier: AGPL-3.0-only
//
// SAMPLE VALUES, NOT A RECORD. The task page's fact strip (DS-TASK-1) and seven
// of its ten fields (TP-10) have no read on batch/1: no client, estimate,
// project, category, stage, page link or handling flags, and no derived whose
// move or rank. The page draws them as the mockup shows them, from these
// constants, and only inside the shared mock label (`SourceRegion` with
// `provenance="mock"`), so nobody reads them as this task's facts.
//
// The real wiring replaces this module whole: when a read carries a field, the
// field leaves this file and its mock label goes in the same commit.

/** The fact strip: who holds the next move, the rank, and the two handling ticks. */
export const SAMPLE_STRIP = {
  whoseMove: 'Review',
  /** No rank: the strip reads "not ranked" (the mockup's gate task). */
  rank: null as number | null,
  adHoc: false,
  clientAccess: true,
} as const;

/** The seven fields batch/1 has no read for, in the mockup's labels. */
export const SAMPLE_FIELDS = {
  Client: 'Meridian Dental',
  Estimate: '2h',
  Project: 'Website Projects',
  Category: 'Content',
  Stage: 'Enquiries',
  'Page link': 'nothing yet',
} as const;

export type SampleField = keyof typeof SAMPLE_FIELDS | 'Handling';
