// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the review commands' data effects (C35, #2011), spread into `COMMAND_EFFECTS`.
// Each writes rows that hold a task's id, so each is `client-data`, and the land takes a
// page capture in as well: the first-client gate refuses them while readiness is false.

import type { CommandName } from './command-names.ts';
import { client, writing, type DataEffects } from './data-effects-types.ts';

export const REVIEW_EFFECTS: {
  readonly [Name in Extract<CommandName, `review.${string}`>]: DataEffects;
} = {
  'review.open': writing(client('review_revisions', 'reviews')),
  'review.capture': writing(client('review_captures')),
  'review.capture_claim': writing(client('review_captures')),
  'review.capture_land': {
    ...writing(client('review_captures', 'storage_objects')),
    intake: ['page-capture'],
  },
  // A pin is a comment on the review's task.
  'review.pin_comment': writing(client('records')),
  // C57: a change request names the review's task and its pin (#2016).
  'review.propose_change': writing(client('review_change_requests')),
  'review.decide_change': writing(client('review_change_requests')),
  'review.read': writing([]),
  'review.picture': writing([]),
};
