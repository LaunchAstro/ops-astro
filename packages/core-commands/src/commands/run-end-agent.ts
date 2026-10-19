// SPDX-License-Identifier: AGPL-3.0-only
//
// `run.end` on the agent prefix (#1623 R1): the worker's own stop, on the lease its delegation
// holds. The runtime (`core-runtime/src/run-end.ts`) records the outcome and retires the work under
// its locks; the answer is a retained terminal refusal, `RUN_ENDED` naming the outcome and its
// code, so the stop commits with its register row and audit event although it revoked the
// delegation it is judged on, and the same operation id replays it.

import type { Delegation, TenantQuery } from '../../../core-records/src/index.ts';
import { endRun } from '../../../core-runtime/src/index.ts';
import type { AgentCall, AgentRequest, NoOperands } from './agent-call.ts';
import { isIdentifier } from './operands.ts';
import { refused, refusedRetaining, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';

const ENDED_FIXES: readonly string[] = [
  'The run stopped here and its outcome is recorded. A person starts any new attempt.',
];

/** The row `agent-operations.ts` serves `run.end` by. */
export const RUN_END: {
  readonly authority: 'record';
  readonly subjectTask: 'lease';
  readonly replay: 'reauthorise';
  readonly operands: (request: AgentRequest) => NoOperands;
  readonly serve: (
    tx: TenantQuery,
    call: AgentCall,
    operands: NoOperands,
    delegation: Delegation,
  ) => Promise<HandlerOutcome>;
} = {
  authority: 'record',
  subjectTask: 'lease',
  replay: 'reauthorise',
  operands: () => ({}),
  serve: async (tx, { session, request }, _operands, delegation) => {
    const { leaseId, fence, endCode } = request;
    if (!isIdentifier(leaseId) || typeof fence !== 'number' || !Number.isSafeInteger(fence)) {
      return refused(
        refuseCommand(
          'FIELD_VALUE_INVALID',
          ['leaseId', 'fence'],
          ['Send the lease and fence the pickup handed back.'],
        ),
      );
    }
    const ended = await endRun(tx, {
      leaseId,
      fence,
      endCode,
      holderActorId: session.actorId,
      delegationId: delegation.id,
    });
    if (!ended.ok) return refused(ended.refusal);
    const { outcome, endCode: stored } = ended.value;
    return refusedRetaining(refuseCommand('RUN_ENDED', [outcome, stored], ENDED_FIXES));
  },
};
