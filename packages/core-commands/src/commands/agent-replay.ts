// SPDX-License-Identifier: AGPL-3.0-only
//
// A stored success released on replay by the operation's `replay` row
// (`agent-operations.ts`). A stored refusal carries nothing protected and is
// never passed to `releaseReplay`. Nothing here repeats anything: the refusal
// comes back, not the stored detail, when the rights are gone.

import {
  checkDelegatedAuthority,
  digestOf,
  resolveLiveById,
  resolveSettledByLease,
  DERIVED_SCHEME,
  LEGACY_SCHEME,
  isUuid,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { delegationCredentialKeys } from '../../../core-runtime/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import type { CommandHandle, CommandResult } from './register-store.ts';
import { authorise, NO_DELEGATION_FIXES } from './agent-authority.ts';
import { isOperandRefusal, type AgentOperation, type TypedOperation } from './agent-operations.ts';
import { isRefused } from './outcome.ts';
import type { AgentCall } from './agent-call.ts';
import { PICKUP_REPLAY_FIXES, pickupReceiptBinding } from './pickup-receipt.ts';

/**
 * The stored success as the rights held now release it: the answer to hand
 * back in its place, a refusal, or nothing when the receipt goes out as stored.
 */
export async function releaseReplay(
  tx: TenantQuery,
  call: AgentCall,
  operation: AgentOperation,
  stored: CommandHandle,
): Promise<CommandResult | undefined> {
  switch (operation.replay) {
    case 'pickup':
      return await replayPickup(tx, call, stored);
    case 'capabilities':
      return await operation.open(async (row) => await replayCapabilities(tx, call, row));
    case 'settledHandback':
      return await replaySettledHandback(tx, call, stored);
    case 'reauthorise':
      return await operation.open(async (row) => {
        const authorised = await authorise(tx, call, row);
        return 'refusal' in authorised ? authorised.refusal : undefined;
      });
  }
}

/**
 * A capabilities replay: the current rights checked the way a fresh call is,
 * then the row served again for them. The stored answer is never released.
 */
async function replayCapabilities<O extends object>(
  tx: TenantQuery,
  call: AgentCall,
  operation: TypedOperation<O>,
): Promise<CommandResult> {
  const authorised = await authorise(tx, call, operation);
  if ('refusal' in authorised) return authorised.refusal;
  // The row's own operands, read as a fresh call reads them: the capabilities
  // row reads none, so this is its `{}`, typed as the row's own.
  const operands = operation.operands(call.request);
  if (isOperandRefusal(operands)) return operands.refusal;
  const served = await authorised.run(operands);
  if (isRefused(served)) return served.refusal;
  return { command: call.request.command, ...served };
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
