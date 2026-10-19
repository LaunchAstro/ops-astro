// SPDX-License-Identifier: AGPL-3.0-only
//
// The review commands' rows (C35, #2011), spread into `COMMAND_SURFACE` in `surface.ts`
// (kept apart for the line cap); their operands are `write-operands-review.ts`.
//
// `review.open` and `review.capture` are `review:write` at the review's holder, the
// task's client or the business for its own site (`prepare.ts`, TARGET_LOOKUPS), an
// agent's inside its delegation. The read is `review:read` at the holder, asked
// inside the query.

import type { CommandDeclaration } from './surface-declaration.ts';
import { declare, read } from './surface-builders.ts';

const REVIEW_COLLECTION = 'review';

export const REVIEW_SURFACE: readonly CommandDeclaration[] = [
  read('review.read', REVIEW_COLLECTION),
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
];
