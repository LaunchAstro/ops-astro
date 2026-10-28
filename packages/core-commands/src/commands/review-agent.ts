// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's rows in the agent operation table (#2011), spread into `AGENT_OPERATIONS` with that
// table's own closure, kept apart for its line cap. A pickup's delegation reaches one task
// and never carries `review`, so the open and the capture ask are `business` rows, refused
// outside the delegation's purpose as `task.create` is; an agent credential reaches them
// through the person envelope with its ticked keys (API-2). The claim and the land are
// the worker's, asked of the lease's task and served under the delegation `authorise`
// resolved, as `task.check` is. A pin (#2012) is a `record` row: `review:comment` on the
// delegation's own task, served on that task alone (`review-pin.ts`).
// A change request's filing (#2016) is a `record` row that is refused CLIENT_MODEL_USE_OFF
// (`review-change.ts`); its decision has no row, as the surface never offers it to an agent.

import type { Delegation, TenantQuery } from '../../../core-records/src/index.ts';
import type { AgentCall, NoOperands } from './agent-call.ts';
import type { HandlerOutcome } from './outcome.ts';
import { claimCapture, landCapture } from './review-captures.ts';
import { PIN_COMMENT } from './review-pin.ts';
import { PROPOSE_CHANGE } from './review-change.ts';

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

/** A worker's row: the lease the body names is the task the check asks of. */
export interface UnderLease {
  readonly authority: 'record';
  readonly subjectTask: 'lease';
  readonly replay: 'reauthorise';
  readonly operands: () => NoOperands;
  readonly serve: (
    tx: TenantQuery,
    call: AgentCall,
    operands: NoOperands,
    delegation: Delegation,
  ) => Promise<HandlerOutcome>;
}

const underLease = (serve: typeof claimCapture | typeof landCapture): UnderLease => ({
  authority: 'record',
  subjectTask: 'lease',
  replay: 'reauthorise',
  operands: () => ({}),
  serve: async (tx, { session, request }, _, delegation) =>
    await serve(
      tx,
      {
        leaseId: request['leaseId'],
        fence: request['fence'],
        revisionId: request['revisionId'],
        width: request['width'],
        picture: request['picture'],
        observation: request['observation'],
      },
      { claimant: 'agent', holderActorId: session.actorId, delegation },
    ),
});

type ReviewAgentName =
  | 'review.open'
  | 'review.capture'
  | 'review.capture_claim'
  | 'review.capture_land'
  | 'review.pin_comment'
  | 'review.propose_change';

export const reviewAgentRows = <T>(
  close: (typed: OutsidePurpose | UnderLease | typeof PIN_COMMENT | typeof PROPOSE_CHANGE) => T,
): readonly (readonly [ReviewAgentName, T])[] => [
  ['review.open', close(OUTSIDE_PURPOSE)],
  ['review.capture', close(OUTSIDE_PURPOSE)],
  ['review.capture_claim', close(underLease(claimCapture))],
  ['review.capture_land', close(underLease(landCapture))],
  ['review.pin_comment', close(PIN_COMMENT)],
  ['review.propose_change', close(PROPOSE_CHANGE)],
];
