// SPDX-License-Identifier: AGPL-3.0-only
//
// `live correction requested` by an agent, inside its delegation (the
// permissions table: `run:write`, an agent may hold it inside its delegation),
// split out of `live-corrections.ts` so that file stays under the per-file
// size cap. One check answers the request and its replay, so a stored receipt
// goes back only to a delegation that could make that request now.

import { checkAuthority, RUN_COLLECTION } from '../../../core-records/src/index.ts';
import type { Delegation, TenantQuery } from '../../../core-records/src/index.ts';
import { readTaskSpine } from './context.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import { storeRequest, typedOperands, type RequestOperands } from './live-corrections.ts';

const OUT_OF_PURPOSE = refuseCommand(
  'DELEGATION_OUT_OF_PURPOSE',
  ['taskId'],
  ['A delegation reaches only the task it was minted for.'],
);
const OUTSIDE_DELEGATION = refuseCommand(
  'DELEGATION_EXCLUDES_OPERATION',
  ['live_correction.request'],
  ['This delegation does not carry run:write on the task it was minted for.'],
);

/**
 * The request inside `delegation`: worked under the delegation's own task,
 * the delegation carrying `run` and `write`, and the delegating person's live
 * grant covering `run:write` at the named party now. Another task is outside
 * the purpose whatever the delegation carries, and the operands' shape is
 * judged after both, so a caller holding nothing is told that first.
 */
async function withinDelegation(
  tx: TenantQuery,
  sent: Readonly<Record<string, unknown>>,
  delegation: Delegation,
): Promise<RequestOperands | { readonly refusal: CommandRefusal }> {
  const taskId = sent['taskId'];
  if (typeof taskId !== 'string' || delegation.purposeScope.id !== taskId.toLowerCase()) {
    return { refusal: OUT_OF_PURPOSE };
  }
  const carries =
    delegation.collections.includes(RUN_COLLECTION) && delegation.actions.includes('write');
  if (!carries) return { refusal: OUTSIDE_DELEGATION };
  const operands = typedOperands(sent);
  if ('refusal' in operands) return operands;
  const covered = await checkAuthority(tx, [{ kind: 'person', id: delegation.delegatePersonId }], {
    collection: RUN_COLLECTION,
    action: 'write',
    scope: { kind: 'party', id: operands.partyId },
  });
  return covered.ok ? operands : { refusal: covered.refusal };
}

/**
 * The request by an agent. The person recorded as the requester is the
 * delegating person, so they cannot approve it either.
 */
export async function requestAsAgent(
  tx: TenantQuery,
  agentActorId: string,
  sent: Readonly<Record<string, unknown>>,
  delegation: Delegation,
): Promise<HandlerOutcome> {
  const operands = await withinDelegation(tx, sent, delegation);
  if ('refusal' in operands) return refused(operands.refusal);
  const spine = await readTaskSpine(tx);
  const personId = delegation.delegatePersonId;
  return await storeRequest(
    tx,
    spine.taskTypeId,
    {
      actorId: agentActorId,
      personId,
      delegationId: delegation.id,
      subjects: [{ kind: 'person', id: personId }],
    },
    operands,
  );
}

/**
 * A replay's answer under the delegation presented now: the refusal, or
 * undefined when the stored receipt may go back. A replay carries the same
 * body (`OPERATION_ID_REUSED` refuses another), so it names the stored
 * request's task and party, and the request's own check is asked again. A
 * later delegation for another task or client gets the refusal, never the
 * receipt.
 */
export async function replayRefusal(
  tx: TenantQuery,
  sent: Readonly<Record<string, unknown>>,
  delegation: Delegation,
): Promise<CommandRefusal | undefined> {
  const within = await withinDelegation(tx, sent, delegation);
  return 'refusal' in within ? within.refusal : undefined;
}
