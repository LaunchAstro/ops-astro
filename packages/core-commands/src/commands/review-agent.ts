// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's rows in the agent operation table (#2011), spread into `AGENT_OPERATIONS` with that
// table's own closure, kept apart for its line cap. A pickup's delegation reaches one task
// and never carries `review`, so the open and the capture ask are `business` rows, refused
// outside the delegation's purpose as `task.create` is; an agent credential reaches them
// through the person envelope with its ticked keys (API-2). A pin (#2012) is a `record` row:
// `review:comment` on the delegation's own task, served on that task alone (`review-pin.ts`).

import type { NoOperands } from './agent-call.ts';
import { PIN_COMMENT } from './review-pin.ts';

/** A row a pickup's delegation never reaches: no operands, no `serve`. */
export interface OutsidePurpose {
  readonly authority: 'business';
  readonly replay: 'reauthorise';
  readonly operands: () => NoOperands;
}

const OUTSIDE_PURPOSE: OutsidePurpose = {
  authority: 'business',
  replay: 'reauthorise',
  operands: () => ({}),
};

export const reviewAgentRows = <T>(
  close: (typed: OutsidePurpose | typeof PIN_COMMENT) => T,
): readonly (readonly ['review.open' | 'review.capture' | 'review.pin_comment', T])[] => [
  ['review.open', close(OUTSIDE_PURPOSE)],
  ['review.capture', close(OUTSIDE_PURPOSE)],
  ['review.pin_comment', close(PIN_COMMENT)],
];
