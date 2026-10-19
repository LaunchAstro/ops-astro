// SPDX-License-Identifier: AGPL-3.0-only
//
// C35's rows in the agent operation table (#2011, #2103), spread into `AGENT_OPERATIONS` with
// that table's own closure, kept apart for its line cap. The open and the capture ask are
// `record` rows checked on the task their body names (`reviewTaskOf`), so a delegation reaches
// them only when it carries `review:write` and was minted for that task; a pickup's never
// carries `review`. The agent writes for its delegating person, on the grants the delegation
// draws on, and both those grants and the delegation are asked again after the write's last
// lock wait (`review-commands.ts`). An agent credential reaches both through the person
// envelope with its ticked keys (API-2). The claim and the land are the worker's, asked of
// the lease's task and served under the delegation `authorise` resolved, as `task.check` is.
// A pin (#2012) is a `record` row: `review:comment` on the delegation's own task, served on
// that task alone (`review-pin.ts`).
// A change request's filing (#2016) is a `record` row that is refused CLIENT_MODEL_USE_OFF
// (`review-change.ts`); its decision has no row, as the surface never offers it to an agent.
// The worker's `review.make_change_task` (#2117) is a lease row: `task:write` on the leased task.

import { delegatingSubjects, isUuid, REVIEW_COLLECTION } from '../../../core-records/src/index.ts';
import type { Delegation, TenantQuery } from '../../../core-records/src/index.ts';
import type { AgentCall, AgentRequest, NoOperands } from './agent-call.ts';
import type { HandlerOutcome } from './outcome.ts';
import { claimCapture, landCapture } from './review-captures.ts';
import {
  askReviewCaptureAs,
  openReviewAs,
  type ReviewActing,
  type ReviewCapture,
  type ReviewOpen,
} from './review-commands.ts';
import { PIN_COMMENT } from './review-pin.ts';
import { PROPOSE_CHANGE } from './review-change.ts';
import { MAKE_CHANGE_TASK } from './review-change-task.ts';

/** A review row: checked on the task its body names, and served under that delegation. */
export interface ReviewAgentRow {
  readonly authority: 'record';
  readonly subjectTask: 'review';
  readonly replay: 'reauthorise';
  readonly operands: () => NoOperands;
  readonly serve: (
    tx: TenantQuery,
    call: AgentCall,
    operands: NoOperands,
    delegation: Delegation,
  ) => Promise<HandlerOutcome>;
}

/**
 * The task a review body names: the open's `taskId`, or the task of the capture's revision's
 * review, read in this business. Never a `recordId`, so a stray one steers nothing. A review's
 * task and a revision's review are never updated (20261019050000), so the task read here is
 * the one the write lands on.
 */
export async function reviewTaskOf(
  tx: TenantQuery,
  request: AgentRequest,
): Promise<string | undefined> {
  if (request.command === 'review.open') {
    const taskId = request['taskId'];
    return typeof taskId === 'string' ? taskId.toLowerCase() : undefined;
  }
  const revisionId = request['revisionId'];
  if (!isUuid(revisionId)) return undefined;
  const [row] = await tx.query<{ readonly task_id: string }>(
    `select c.task_id from public.review_revisions v
       join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
      where v.business_id = $1 and v.id = $2`,
    [tx.businessId, revisionId.toLowerCase()],
  );
  return row?.task_id;
}

/** The agent writing for its delegating person, on the grants the delegation draws on. */
const agentActing = async (
  tx: TenantQuery,
  agentActorId: string,
  delegation: Delegation,
): Promise<ReviewActing> => ({
  covering: {
    subjects: await delegatingSubjects(tx, delegation),
    collection: REVIEW_COLLECTION,
    action: 'write',
  },
  writer: {
    actorId: agentActorId,
    personId: delegation.delegatePersonId,
    delegationId: delegation.id,
  },
});

// The envelope has parsed the body against its surface row before `serve` (`agent-envelope.ts`).
const OPEN: ReviewAgentRow = {
  authority: 'record',
  subjectTask: 'review',
  replay: 'reauthorise',
  operands: () => ({}),
  serve: async (tx, { session, request }, _operands, delegation) =>
    await openReviewAs(
      tx,
      await agentActing(tx, session.actorId, delegation),
      request as unknown as ReviewOpen,
    ),
};

const CAPTURE: ReviewAgentRow = {
  ...OPEN,
  serve: async (tx, { session, request }, _operands, delegation) =>
    await askReviewCaptureAs(
      tx,
      await agentActing(tx, session.actorId, delegation),
      request as unknown as ReviewCapture,
    ),
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
  | 'review.propose_change'
  | 'review.make_change_task';

export const reviewAgentRows = <T>(
  close: (
    typed:
      | ReviewAgentRow
      | UnderLease
      | typeof PIN_COMMENT
      | typeof PROPOSE_CHANGE
      | typeof MAKE_CHANGE_TASK,
  ) => T,
): readonly (readonly [ReviewAgentName, T])[] => [
  ['review.open', close(OPEN)],
  ['review.capture', close(CAPTURE)],
  ['review.capture_claim', close(underLease(claimCapture))],
  ['review.capture_land', close(underLease(landCapture))],
  ['review.pin_comment', close(PIN_COMMENT)],
  ['review.propose_change', close(PROPOSE_CHANGE)],
  ['review.make_change_task', close(MAKE_CHANGE_TASK)],
];
