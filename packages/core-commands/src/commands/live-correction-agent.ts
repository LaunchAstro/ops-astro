// SPDX-License-Identifier: AGPL-3.0-only
//
// `live correction requested` by an agent, inside its delegation (the
// permissions table: `run:write`, an agent may hold it inside its delegation),
// split out of `live-corrections.ts` so that file stays under the per-file
// size cap. One check answers the request and its replay, so a stored receipt
// goes back only to a delegation that could make that request now.

import { ownersOwn, readPage } from '../../../core-custody/src/index.ts';
import { checkAuthority, RUN_COLLECTION, taskClient } from '../../../core-records/src/index.ts';
import type { Delegation, TenantQuery } from '../../../core-records/src/index.ts';
import { readTaskSpine } from './context.ts';
import { lockedClientOf } from './tasks-party.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { isRefused, refused, type HandlerOutcome } from './outcome.ts';
import {
  requestOperands,
  storeRequest,
  typedOperands,
  type RequestOperands,
} from './live-corrections.ts';

const OUT_OF_PURPOSE = refuseCommand(
  'DELEGATION_OUT_OF_PURPOSE',
  ['taskId'],
  ['A delegation reaches only the task it was minted for.'],
);
const NOT_OWN_WORK = refuseCommand(
  'CORRECTION_NOT_OWN_WORK',
  ['taskId'],
  [
    "An agent asks on the business's own site only from a task its owner started that no client, agent or worker has written.",
  ],
);
const OUTSIDE_DELEGATION = refuseCommand(
  'DELEGATION_EXCLUDES_OPERATION',
  ['live_correction.request'],
  ['This delegation does not carry run:write on the task it was minted for.'],
);

/**
 * The request inside `delegation`: worked under the delegation's own task,
 * the delegation carrying `run` and `write`, and the delegating person's live
 * grant covering `run:write` at the task's client now. Another task is outside
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
  // Asked at the task's client; a task with no client is the business's own site (R6).
  const partyId = (await taskClient(tx, operands.taskId)) ?? null;
  const covered = await checkAuthority(tx, [{ kind: 'person', id: delegation.delegatePersonId }], {
    collection: RUN_COLLECTION,
    action: 'write',
    scope: partyId === null ? { kind: 'business', id: null } : { kind: 'party', id: partyId },
  });
  return covered.ok ? operands : { refusal: covered.refusal };
}

/**
 * The refusal unless a request on the business's own site comes from the
 * owner's own internal work, judged as the broker judges a run's task (S2,
 * owner line 72, R6). It reads the task after the agent's own standing waits
 * (`lastCheck`): storage took the task's client as the request's party in its
 * insert and holds the task `for share` until commit, so the client read here
 * is the party it stored, whatever the task held before the site lock's wait.
 * A task with a client was judged at that client's grant; a task this cannot
 * read is refused. A replay asks it after its audit event's chain wait
 * (`replayOwnWork`).
 */
async function ownWorkRefusal(
  tx: TenantQuery,
  operands: RequestOperands,
): Promise<CommandRefusal | undefined> {
  const task = await readPage(tx, operands.taskId);
  if (task === undefined) return NOT_OWN_WORK;
  if (task.clientId !== null) return undefined;
  return ownersOwn(task.source) ? undefined : NOT_OWN_WORK;
}

/**
 * The request by an agent. The person recorded as the requester is the
 * delegating person, so they cannot approve it either. Its stored row rolls
 * back with a refusal of its own-work check.
 */
export async function requestAsAgent(
  tx: TenantQuery,
  agentActorId: string,
  sent: Readonly<Record<string, unknown>>,
  delegation: Delegation,
): Promise<HandlerOutcome> {
  const operands = await withinDelegation(tx, sent, delegation);
  if ('refusal' in operands) return refused(operands.refusal);
  const stored = await storeAsAgent(tx, agentActorId, operands, delegation);
  if (isRefused(stored)) return stored;
  return { ...stored, lastCheck: async () => await ownWorkRefusal(tx, operands) };
}

async function storeAsAgent(
  tx: TenantQuery,
  agentActorId: string,
  operands: RequestOperands,
  delegation: Delegation,
): Promise<HandlerOutcome> {
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
 * request's task, and the request's own checks are asked again. A later
 * delegation for another task or client gets the refusal, never the receipt;
 * the own-work check is asked last (`replayOwnWork`). The task is then held
 * `for share` to commit, before the replay's audit event as every task write
 * takes its task before the audit chain, so a client set while the replay
 * waits waits for it, and `replayOwnWork` reads one client.
 */
export async function replayRefusal(
  tx: TenantQuery,
  sent: Readonly<Record<string, unknown>>,
  delegation: Delegation,
): Promise<CommandRefusal | undefined> {
  const within = await withinDelegation(tx, sent, delegation);
  if ('refusal' in within) return within.refusal;
  await lockedClientOf(tx, (await readTaskSpine(tx)).taskTypeId, within.taskId);
  return undefined;
}

/**
 * A released replay's own-work check, asked after its audit event's chain
 * wait (`Entry.lastCheck`) under the delegation presented then, on the task
 * `replayRefusal` holds: the grant and the own-work check read one client,
 * and a task that is no longer the owner's own work gets the refusal, never
 * the receipt.
 */
export async function replayOwnWork(
  tx: TenantQuery,
  sent: Readonly<Record<string, unknown>>,
  delegation: Delegation,
): Promise<CommandRefusal | undefined> {
  const operands = await withinDelegation(tx, sent, delegation);
  return 'refusal' in operands ? operands.refusal : await ownWorkRefusal(tx, operands);
}

/** `live_correction.request`'s agent row: replayed only to a delegation that could make it now. */
export const CORRECTION_REQUEST: {
  readonly authority: 'purpose';
  readonly replay: 'correctionRequest';
  readonly operands: typeof requestOperands;
  readonly serve: (
    tx: TenantQuery,
    call: { readonly session: { readonly actorId: string } },
    operands: Readonly<Record<string, unknown>>,
    delegation: Delegation,
  ) => Promise<HandlerOutcome>;
} = {
  authority: 'purpose',
  replay: 'correctionRequest',
  operands: requestOperands,
  serve: async (tx, { session }, operands, delegation) =>
    await requestAsAgent(tx, session.actorId, operands, delegation),
};
