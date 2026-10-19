// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the review commands' data effects (C35, #2011), spread into `COMMAND_EFFECTS`.
// Each writes rows that hold a task's id, so each is `client-data`: the first-client gate
// refuses them while readiness is false.

import type { CommandName } from './command-names.ts';
import { client, writing, type DataEffects } from './data-effects-types.ts';

export const REVIEW_EFFECTS: {
  readonly [Name in Extract<CommandName, `review.${string}`>]: DataEffects;
} = {
  'review.open': writing(client('review_revisions', 'reviews')),
  'review.capture': writing(client('review_captures')),
  'review.read': writing([]),
};
