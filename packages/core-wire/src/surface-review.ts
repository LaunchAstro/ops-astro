// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' rows (C35, #2011), spread into `COMMAND_SURFACE` in `surface.ts`
// (kept apart for the line cap); their operands are `write-operands-review.ts`.
//
// `review.open` and `review.capture` are `review:write` at the review's holder, the
// task's client or the business for its own site (`prepare.ts`, TARGET_LOOKUPS), an
// agent's inside its delegation. `review.pin_comment` (#2012) is `review:comment` there, an
// agent's inside a delegation for the review's own task. The claim and the land are the
// worker's: asked of the lease's task like `task.check`, the lease the authority, never a
// person's grant beyond the one the lease stands on. The reads are `review:read` at the
// holder, asked inside the query.
//
// C57's change requests (#2016) are `proposal:write` and `proposal:decide` there. A filing
// is a person's: an agent inside a delegation for the review's task reaches it only to be
// refused CLIENT_MODEL_USE_OFF. A decision is never an agent's.

import type { CommandDeclaration } from './surface-declaration.ts';
import { declare, read } from './surface-builders.ts';

const REVIEW_COLLECTION = 'review';
const PROPOSAL_COLLECTION = 'proposal';

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
  declare('review.pin_comment', 'comment', {
    collection: REVIEW_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['revisionId'],
    agent: 'delegated',
  }),
  declare('review.propose_change', 'write', {
    collection: PROPOSAL_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['commentId'],
    agent: 'delegated',
  }),
  declare('review.decide_change', 'decide', {
    collection: PROPOSAL_COLLECTION,
    targetsExistingRecord: false,
    authorisedOn: 'target',
    untargetedIdentifiers: ['changeRequestId'],
  }),
];
