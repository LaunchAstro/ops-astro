// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's rows in the agent operation table (#2011), spread into `AGENT_OPERATIONS` with
// that table's own closure, kept apart for its line cap. A pickup's delegation reaches
// one task and never carries `review`, so the open and the capture ask are `business`
// rows, refused outside the delegation's purpose as `task.create` is; an agent credential
// reaches them through the person envelope with its ticked keys (API-2). The claim and
// the land are the worker's, asked of the lease's task and served under the delegation
// `authorise` resolved, as `task.check` is.

import type { CommandName } from '../../../core-wire/src/index.ts';
import type { AgentOperation, TypedOperation } from './agent-operations.ts';
import type { AgentCall, NoOperands } from './agent-call.ts';
import type { Delegation, TenantQuery } from '../../../core-records/src/index.ts';
import { claimCapture, landCapture } from './review-captures.ts';

const NONE = (): NoOperands => ({});

const OUTSIDE_PURPOSE: TypedOperation<NoOperands> = {
  authority: 'business',
  replay: 'reauthorise',
  operands: NONE,
};

const underLease = (
  serve: typeof claimCapture | typeof landCapture,
): TypedOperation<NoOperands> => ({
  authority: 'record',
  subjectTask: 'lease',
  replay: 'reauthorise',
  operands: NONE,
  serve: async (tx: TenantQuery, { session, request }: AgentCall, _, delegation: Delegation) =>
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
      { claimant: 'agent', holderActorId: session.actorId, delegationId: delegation.id },
    ),
});

export const reviewAgentRows = (
  close: (typed: TypedOperation<NoOperands>) => AgentOperation,
): readonly (readonly [CommandName, AgentOperation])[] => [
  ['review.open', close(OUTSIDE_PURPOSE)],
  ['review.capture', close(OUTSIDE_PURPOSE)],
  ['review.capture_claim', close(underLease(claimCapture))],
  ['review.capture_land', close(underLease(landCapture))],
];
