// SPDX-License-Identifier: AGPL-3.0-only
//
// A stored agent success judged again after the replay's last wait (#2307).
// `release` judges the replay before its `replayed` audit insert, which waits
// on the business's audit chain, and a delegation, grant or lease can run out
// in that wait. So each replay that answers to a standing asks it again, as
// the entry's `lastCheck`, and a refusal takes the event back.
//
// Two replays ask nothing again. A take that named a launch is judged in
// `workJudged`, which already holds the chain when it judges, and an empty
// take releases nothing. A helper's handback answers to its credential, live
// or not (`replayChildHandback`).

import {
  checkDelegatedAuthority,
  isUuid,
  resolveDelegation,
  resolveSettledByLease,
} from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { authorise, NO_DELEGATION_FIXES } from './agent-authority.ts';
import type { AgentCall } from './agent-call.ts';
import { replayChildPickup } from './agent-child.ts';
import { leaseLapsed } from './lease-replay.ts';
import type { AgentOperation } from './agent-operations.ts';
import { replayOwnWork } from './live-correction-agent.ts';
import { pickupStanding } from './pickup-receipt.ts';
import { isCommandRefusal, refuseCommand, type CommandRefusal } from './refusal.ts';
import type { CommandHandle } from './register-store.ts';

type Again = (
  tx: TenantQuery,
  call: AgentCall,
  operation: AgentOperation,
  stored: CommandHandle,
) => Promise<CommandRefusal | undefined>;

/**
 * What `authorise` judged at release, asked again, with the lease a lease
 * command named under the delegation it resolved (#2332); then a hand-over's
 * child (`replayChildPickup`) or an own-site correction request's own work
 * (#1877).
 */
const reauthorised: Again = async (tx, call, operation, stored) => {
  const lapsed = await operation.open(async (row) => {
    const authorised = await authorise(tx, call, row);
    if ('refusal' in authorised) return authorised.refusal;
    const delegationId = authorised.asked?.delegation.id;
    return await leaseLapsed(tx, call.declaration, call.request, {
      claimant: 'agent',
      actorId: call.session.actorId,
      ...(delegationId === undefined ? {} : { delegationId }),
    });
  });
  if (lapsed !== undefined) return lapsed;
  if (operation.replay === 'childPickup') {
    const child = await replayChildPickup(tx, call, stored);
    return isCommandRefusal(child) ? child : undefined;
  }
  if (operation.replay !== 'correctionRequest') return lapsed;
  // `authorise` resolved this credential as live a statement ago.
  const resolved = await resolveDelegation(tx, call.session.actorId, call.credential ?? '');
  return resolved.ok ? await replayOwnWork(tx, call.request, resolved.value) : resolved.refusal;
};

/** Each replay's judgement after its last wait; one not named asks nothing again. */
export const JUDGED_AGAIN: Partial<Record<AgentOperation['replay'], Again>> = {
  reauthorise: reauthorised,
  serveAgain: reauthorised,
  childPickup: reauthorised,
  correctionRequest: reauthorised,
  pickup: async (tx, call, _operation, stored) => {
    const standing = await pickupStanding(tx, call, stored);
    return 'refusal' in standing ? standing.refusal : undefined;
  },
  settledHandback: async (tx, call, _operation, stored) =>
    await replaySettledHandback(tx, call, stored),
};

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
export async function replaySettledHandback(
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
