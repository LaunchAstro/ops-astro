// SPDX-License-Identifier: AGPL-3.0-only
//
// A stored success released on replay by the operation's `replay` row
// (`agent-operations.ts`). A stored refusal carries nothing protected and is
// never passed to `releaseReplay`. Nothing here repeats anything: the refusal
// comes back, not the stored detail, when the rights are gone.

import {
  digestOf,
  resolveDelegation,
  DERIVED_SCHEME,
  LEGACY_SCHEME,
} from '../../../core-records/src/index.ts';
import type { TenantQuery, VerifiedSubject } from '../../../core-records/src/index.ts';
import { delegationCredentialKeys } from '../../../core-runtime/src/index.ts';
import { refuseCommand } from './refusal.ts';
import type { CommandHandle, CommandResult } from './register-store.ts';
import { authorise } from './agent-authority.ts';
import { isOperandRefusal, type AgentOperation, type TypedOperation } from './agent-operations.ts';
import { isRefused } from './outcome.ts';
import { workJudged } from './agent-standing.ts';
import type { AgentCall } from './agent-call.ts';
import type { IdentifiedRequest } from './requests.ts';
import type { Replaying } from './envelope.ts';
import { pickupStanding } from './pickup-receipt.ts';
import { replayChildHandback, replayChildPickup } from './agent-child.ts';
import { replayRefusal } from './live-correction-agent.ts';
import { JUDGED_AGAIN, replaySettledHandback } from './agent-replay-again.ts';
import { presentedCredential } from './tasks-take-launch.ts';

/**
 * The stored success as the rights held now release it: the answer to hand
 * back in its place, a refusal, or nothing when the receipt goes out as stored.
 */
async function releaseReplay(
  tx: TenantQuery,
  call: AgentCall,
  operation: AgentOperation,
  stored: CommandHandle,
  presented: VerifiedSubject,
): Promise<CommandResult | undefined> {
  switch (operation.replay) {
    case 'pickup':
      return await replayPickup(tx, call, stored);
    case 'serveAgain':
      return await operation.open(async (row) => await serveAgain(tx, call, row));
    case 'takeLaunch':
      return await operation.open(
        async (row) => await replayTake(tx, call, row, stored, presented),
      );
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
 * The agent entry's replay (`Replaying`): a stored success released by the
 * row's `replay`, and judged again after the replay's audit-chain wait
 * (`JUDGED_AGAIN`, #2307).
 */
export function replaying(
  tx: TenantQuery,
  callOf: (request: IdentifiedRequest) => AgentCall,
  operation: AgentOperation,
  presented: VerifiedSubject,
): Replaying {
  let released: CommandHandle | undefined;
  const release = async (stored: CommandHandle, request: IdentifiedRequest) => {
    released = stored;
    return await releaseReplay(tx, callOf(request), operation, stored, presented);
  };
  const again = JUDGED_AGAIN[operation.replay];
  if (again === undefined) return { release };
  const lastCheck = async (request: IdentifiedRequest) =>
    released && (await again(tx, callOf(request), operation, released));
  return { release, lastCheck };
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
 * A launch made since is never taken under the old operation identity. The
 * stored answer keeps no credential, so this serve is the one that hands it
 * over, and it is judged again after its waits as a fresh take is.
 */
async function replayTake<O extends object>(
  tx: TenantQuery,
  call: AgentCall,
  operation: TypedOperation<O>,
  stored: CommandHandle,
  presented: VerifiedSubject,
): Promise<CommandResult | undefined> {
  const launchId = stored.detail['launchId'];
  if (typeof launchId !== 'string') {
    const authorised = await authorise(tx, call, operation);
    if ('refusal' in authorised) return authorised.refusal;
    return presentedCredential(call)?.refusal;
  }
  const again = { ...call, request: { ...call.request, launchId } };
  const authorised = await authorise(tx, again, operation);
  if ('refusal' in authorised) return authorised.refusal;
  const operands = operation.operands(again.request);
  if (isOperandRefusal(operands)) return operands.refusal;
  const judged = { call: again, presented, asked: authorised.asked };
  const served = await workJudged(tx, judged, async () => await authorised.run(operands));
  if ('ended' in served) return served.ended;
  if (isRefused(served)) return served.refusal;
  const { recordId, revision, detail } = served;
  return { command: call.request.command, recordId, revision, detail };
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
 *    is still current. Steps 1 to 3 are `pickupStanding`, asked again after
 *    the replay's last wait (#2307).
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
  call: AgentCall,
  stored: CommandHandle,
): Promise<CommandResult> {
  const { session } = call;
  const detail = stored.detail;
  const standing = await pickupStanding(tx, call, stored);
  if ('refusal' in standing) return standing.refusal;
  const { held, bound } = standing;

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
