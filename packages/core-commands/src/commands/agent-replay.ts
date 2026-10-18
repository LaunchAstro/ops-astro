// SPDX-License-Identifier: AGPL-3.0-only
//
// A stored success released on replay by the operation's `replay` row
// (`agent-operations.ts`). A stored refusal carries nothing protected and is
// never passed to `releaseReplay`. Nothing here repeats anything: the refusal
// comes back, not the stored detail, when the rights are gone.

import {
  checkDelegatedAuthority,
  digestOf,
  resolveDelegation,
  resolveLiveById,
  resolveSettledByLease,
  DERIVED_SCHEME,
  LEGACY_SCHEME,
  isUuid,
} from '../../../core-records/src/index.ts';
import type { TenantQuery, VerifiedSubject } from '../../../core-records/src/index.ts';
import { delegationCredentialKeys } from '../../../core-runtime/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import type { CommandHandle, CommandResult } from './register-store.ts';
import { authorise, NO_DELEGATION_FIXES } from './agent-authority.ts';
import { isOperandRefusal, type AgentOperation, type TypedOperation } from './agent-operations.ts';
import { isRefused } from './outcome.ts';
import type { AgentCall } from './agent-call.ts';
import { PICKUP_REPLAY_FIXES, pickupReceiptBinding } from './pickup-receipt.ts';
import { replayChildHandback, replayChildPickup } from './agent-child.ts';
import { replayRefusal } from './live-correction-agent.ts';
import { presentedCredential } from './tasks-take-launch.ts';
import { workJudged } from './agent-standing.ts';
import { keptRead, type DefinitionReadOperands } from './definition-read-agent.ts';

/**
 * The stored success as the rights held now release it: the answer to hand
 * back in its place, a refusal, or nothing when the receipt goes out as stored.
 */
export async function releaseReplay(
  tx: TenantQuery,
  call: AgentCall,
  operation: AgentOperation,
  stored: CommandHandle,
  verified: VerifiedSubject,
): Promise<CommandResult | undefined> {
  switch (operation.replay) {
    case 'definitionRead':
      return await operation.open(
        async (row) => await replayDefinitionRead(tx, call, row, stored, verified),
      );
    case 'pickup':
      return await replayPickup(tx, call, stored);
    case 'serveAgain':
      return await operation.open(async (row) => await serveAgain(tx, call, row));
    case 'takeLaunch':
      return await operation.open(async (row) => await replayTake(tx, call, row, stored));
    case 'settledHandback':
      return await replaySettledHandback(tx, call, stored);
    case 'childPickup':
      return await operation.open(async (row) => {
        const authorised = await authorise(tx, call, row);
        if ('refusal' in authorised) return authorised.refusal;
        return await replayChildPickup(tx, call, stored);
      });
    case 'childHandback':
      return await replayChildHandback(tx, call, stored);
    case 'reauthorise':
      return await operation.open(async (row) => {
        const authorised = await authorise(tx, call, row);
        return 'refusal' in authorised ? authorised.refusal : undefined;
      });
    case 'correctionRequest':
      return await operation.open(async (row) => {
        const authorised = await authorise(tx, call, row);
        if ('refusal' in authorised) return authorised.refusal;
        // `authorise` resolved this credential as live a statement ago.
        const resolved = await resolveDelegation(tx, call.session.actorId, call.credential ?? '');
        if (!resolved.ok) return resolved.refusal;
        return await replayRefusal(tx, call.request, resolved.value);
      });
  }
}

/**
 * A read whose answer depends on the rights held now (`session.capabilities`,
 * `task.queue`): those rights checked the way a fresh call is, then the row
 * served again for them. The stored answer is never released.
 */
async function serveAgain<O extends object>(
  tx: TenantQuery,
  call: AgentCall,
  operation: TypedOperation<O>,
): Promise<CommandResult> {
  const authorised = await authorise(tx, call, operation);
  if ('refusal' in authorised) return authorised.refusal;
  // The row's own operands, read as a fresh call reads them: both rows
  // read none, so this is its `{}`, typed as the row's own.
  const operands = operation.operands(call.request);
  if (isOperandRefusal(operands)) return operands.refusal;
  const served = await authorised.run(operands);
  if (isRefused(served)) return served.refusal;
  return { command: call.request.command, ...served };
}

/**
 * A take's replay answers about the launch its first answer named, never a
 * later one: an empty take stays empty (the stored answer, once the login and
 * the credential it presents are judged again as a fresh take's are), and one
 * that named a launch is served again for that launch alone, as it stands now.
 * A launch made since is never taken under the old operation identity.
 */
async function replayTake<O extends object>(
  tx: TenantQuery,
  call: AgentCall,
  operation: TypedOperation<O>,
  stored: CommandHandle,
): Promise<CommandResult | undefined> {
  const launchId = stored.detail['launchId'];
  if (typeof launchId !== 'string') {
    const authorised = await authorise(tx, call, operation);
    if ('refusal' in authorised) return authorised.refusal;
    return presentedCredential(call)?.refusal;
  }
  return await serveAgain(tx, { ...call, request: { ...call.request, launchId } }, operation);
}

/**
 * The note a replayed pickup carries in place of its credential, when its
 * delegation predates derivation (`legacy-random`) and nothing can give the
 * credential back.
 */
export const CREDENTIAL_NOT_REPLAYED = 'CREDENTIAL_NOT_REPLAYED';

/**
 * A pickup's replay, which is the case where the agent lost the answer that
 * carried its credential and so has none to present (root ruling 6: the
 * deliberate exception to "no credential, no call").
 *
 * In order, and every step reads the rows as they are now:
 *
 * 1. The delegation the receipt names is still live and still this agent's.
 * 2. The delegating person's current grants still cover the pickup's purpose.
 * 3. The receipt's lease, reservation, attempt and delegation are still bound
 *    to one another, to this agent, and to the receipt's task and version. The
 *    lease is live and unexpired, the hold is held, and the approval behind it
 *    is still current.
 * 4. Only then is the credential derived under the delegation's pinned scheme
 *    and key id, and its digest compared with the one stored at mint.
 *
 * A missing key or a digest that does not match is a closed failure. The
 * receipt is not rewritten, nothing is minted in its place, and no lease,
 * hold, expiry or delegation is touched. A `legacy-random` delegation answers
 * its receipt with no credential and says why, because a digest cannot give
 * random bytes back.
 */
async function replayPickup(
  tx: TenantQuery,
  { session, declaration }: AgentCall,
  stored: CommandHandle,
): Promise<CommandResult> {
  const detail = stored.detail;
  const named = detail['delegationId'];
  const held = isUuid(named) ? await resolveLiveById(tx, session.actorId, named) : undefined;
  if (held === undefined) return refuseCommand('DELEGATION_NOT_LIVE', [], PICKUP_REPLAY_FIXES);

  const decision = await checkDelegatedAuthority(tx, held, {
    collection: declaration.collection,
    action: declaration.action,
    scope: held.purposeScope,
  });
  if (!decision.ok) return decision.refusal;

  const binding = await pickupReceiptBinding(tx, {
    holderActorId: session.actorId,
    delegationId: held.id,
    receipt: detail,
  });
  if ('refusal' in binding) return binding.refusal;
  const { bound } = binding;

  // `credential` is read by the spread below and then replaced; the note, if
  // an older row carries one, does not survive into a derived answer.
  const { credentialNote: _note, ...handles } = detail;
  if (bound.credential_scheme === LEGACY_SCHEME) {
    return {
      ...stored,
      detail: { ...handles, credential: null, credentialNote: CREDENTIAL_NOT_REPLAYED },
    };
  }
  const keyId = bound.credential_key_id;
  const keys = delegationCredentialKeys();
  const credential =
    bound.credential_scheme !== DERIVED_SCHEME || keyId === null || !keys.ok
      ? undefined
      : keys.keys.derive(keyId, {
          businessId: tx.businessId,
          agentActorId: session.actorId,
          delegationId: held.id,
        });
  if (credential === undefined) {
    return refuseCommand(
      'DEPENDENCY_NOT_LANDED',
      ['task.pickup', `delegation credential key ${keyId ?? 'unrecorded'}`],
      [
        'This deployment does not hold the key this delegation was minted under.',
        'Restore that key; the pickup is unchanged and replays once it is back.',
      ],
    );
  }
  if (digestOf(credential) !== bound.credential_hash) {
    return refuseCommand(
      'DEPENDENCY_NOT_LANDED',
      ['task.pickup', 'delegation credential integrity'],
      [
        'The credential derived for this pickup does not match the one it was issued.',
        'Nothing was reissued. Restore the key this delegation was minted under.',
      ],
    );
  }
  return { ...stored, detail: { ...handles, credential } };
}

/**
 * Whether a stored handback may be released to the rights held now.
 *
 * Most operations answer to the same check a fresh call does. A pickup has its
 * own path (`replayPickup`). A handback cannot answer to the fresh check
 * either: it settles its own delegation, so the credential that made it no
 * longer resolves as live. Its receipt is released to that same credential,
 * for that delegation's own lease, while the delegation was settled rather
 * than revoked and has not expired, and the person's grants still cover it.
 * With no credential at all, a handback replay is what any bare agent call
 * outside the queue and pickup is (root ruling 6): an exclusion, with nothing
 * of the receipt in it.
 */
async function replaySettledHandback(
  tx: TenantQuery,
  { session, credential, request, declaration }: AgentCall,
  stored: CommandHandle,
): Promise<CommandRefusal | undefined> {
  if (credential === undefined || credential === '') {
    return refuseCommand('DELEGATION_EXCLUDES_OPERATION', [request.command], NO_DELEGATION_FIXES);
  }
  const leaseId = stored.detail['leaseId'];
  const held = isUuid(leaseId)
    ? await resolveSettledByLease(tx, session.actorId, leaseId, credential)
    : undefined;
  if (held === undefined) return refuseCommand('DELEGATION_NOT_LIVE', [], NO_DELEGATION_FIXES);
  const decision = await checkDelegatedAuthority(tx, held, {
    collection: declaration.collection,
    action: declaration.action,
    scope: held.purposeScope,
  });
  return decision.ok ? undefined : decision.refusal;
}

/**
 * A pinned read's replay (#1904): always an answer or a refusal, never the
 * stored row, which holds no text. The call is authorised as a fresh one and
 * its read runs again under `workJudged` on the stored lease, fence, step and
 * run, never the body's, then the final lease check (`definition-read-agent.ts`).
 * It writes no ledger row, copy or event.
 */
async function replayDefinitionRead<O extends object>(
  tx: TenantQuery,
  call: AgentCall,
  operation: TypedOperation<O>,
  stored: CommandHandle,
  verified: VerifiedSubject,
): Promise<CommandResult> {
  const again = keptRead(stored.detail);
  if (again === undefined) throw new Error('definition.read: a stored read without its lease');
  const authorised = await authorise(tx, call, operation);
  if ('refusal' in authorised) return authorised.refusal;
  const operands: DefinitionReadOperands = { ...again, again };
  const judged = { call, presented: verified, authority: operation.authority };
  const outcome = await workJudged(
    tx,
    judged,
    // The row's own serve, which reads `again` in place of a fresh read.
    async () => await authorised.run(operands as unknown as O),
    operation.final,
  );
  if ('ended' in outcome) return outcome.ended;
  if (isRefused(outcome)) return outcome.refusal;
  return { command: call.request.command, ...outcome };
}
