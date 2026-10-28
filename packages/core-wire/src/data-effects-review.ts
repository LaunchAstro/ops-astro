// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the review commands' data effects (C35, #2011), spread into `COMMAND_EFFECTS`.
// Each writes rows that hold a task's id, so each is `client-data`, and the land takes a
// page capture in as well: the first-client gate refuses them while readiness is false.

import type { CommandName } from './command-names.ts';
import { client, writing, type DataEffects } from './data-effects-types.ts';
import { MAP_READ_MODEL } from './data-effects-shapes.ts';

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
  'review.carry_pins': writing(client('review_pin_carries')),
  // A pin is a comment on the review's task.
  'review.pin_comment': writing(client('records')),
  // C57: a change request names the review's task and its pin (#2016).
  'review.propose_change': writing(client('review_change_requests')),
  'review.decide_change': writing(client('review_change_requests')),
  // #2117: the task made of an approved request (a task's tables, as `task.create`), and its link.
  'review.make_change_task': writing([
    ...client('records', 'record_unique_values', 'review_change_requests'),
    ...MAP_READ_MODEL,
  ]),
  'review.read': writing([]),
  'review.list': writing([]),
  'review.picture': writing([]),
  'review.client_list': writing([]),
  'review.decide': writing(client('review_decisions')),
  'review.record_astra_review': writing(client('review_astra_reviews')),
};
