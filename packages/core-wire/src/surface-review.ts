// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' rows (C35, #2011), spread into `COMMAND_SURFACE` in `surface.ts`
// (kept apart for the line cap); their operands are `write-operands-review.ts`.
//
// `review.open` and `review.capture` are `review:write` at the review's holder, the
// task's client or the business for its own site (`prepare.ts`, TARGET_LOOKUPS). An agent
// credential reaches them through its person's envelope; a pickup's delegation never does
// (`review-agent.ts`). The claim and the land are the worker's: asked of the lease's task
// like `task.check`, the lease the authority, never a person's grant beyond the one the lease
// stands on. The reads are `review:read` at the holder, asked inside the query.

import type { CommandDeclaration } from './surface-declaration.ts';
import { declare, read } from './surface-builders.ts';

const REVIEW_COLLECTION = 'review';

const AT_THE_LEASE = {
  targetsExistingRecord: false,
  authorisedOn: 'claim',
  untargetedIdentifiers: ['leaseId', 'revisionId'],
  runtimeShaped: 'leaseId',
  agent: 'delegated',
} as const;

export const REVIEW_SURFACE: readonly CommandDeclaration[] = [
  read('review.read', REVIEW_COLLECTION),
  read('review.picture', REVIEW_COLLECTION),
  declare('review.open', 'write', {
    collection: REVIEW_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['taskId'],
    agent: 'delegated',
  }),
  declare('review.capture', 'write', {
    collection: REVIEW_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['revisionId'],
    agent: 'delegated',
  }),
  declare('review.capture_claim', 'write', AT_THE_LEASE),
  declare('review.capture_land', 'write', AT_THE_LEASE),
];
