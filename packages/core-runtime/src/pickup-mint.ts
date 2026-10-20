// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent's pickup delegation, minted under the claim's locks (`pickup.ts`
// `authoriseClaimant`): expiring with the lease, on the delegating person's
// live grants, which `mintDelegation` reads for itself; nothing is copied
// here, and `purposeScope` is R5's one-task ceiling. A pickup sent under a
// launch's credential mints that launch's child instead, read and write only,
// so the launch's revoke or lapse ends it and `launch-take.ts` holds it to the
// run's commands (#2178).

import { mintDelegation, mintPickupChild } from '../../core-records/src/index.ts';
import type { MintedDelegation, TenantQuery } from '../../core-records/src/index.ts';
import { checkAuthorityAt } from './recovery.ts';
import type { RuntimeResult } from './refusals.ts';

/** What an agent's pickup request carries into its mint. */
export interface AgentMint {
  readonly agentActorId: string;
  readonly authorisedByPersonId: string;
  readonly mintedByActorId: string;
  readonly collection: string;
  readonly launchDelegationId?: string;
}

export async function mintAgentDelegation(
  tx: TenantQuery,
  request: AgentMint,
  work: { readonly task_id: string; readonly purpose: string },
  expiresAt: Date,
  lockedAt: string,
): Promise<RuntimeResult<MintedDelegation>> {
  const common = {
    agentActorId: request.agentActorId,
    delegatePersonId: request.authorisedByPersonId,
    mintedByActorId: request.mintedByActorId,
    purpose: work.purpose,
    collections: await delegatedCollections(tx, request, lockedAt),
    expiresAt,
  };
  const minted =
    request.launchDelegationId === undefined
      ? await mintDelegation(tx, {
          ...common,
          actions: ['read', 'comment', 'write'],
          purposeScope: { kind: 'record', id: work.task_id },
        })
      : await mintPickupChild(tx, request.launchDelegationId, {
          ...common,
          actions: ['read', 'write'],
          taskId: work.task_id,
        });
  return minted.ok ? { ok: true, value: minted.value } : { ok: false, refusal: minted.refusal };
}

/**
 * The collections the agent's delegation reaches: the work's own, and `run`
 * where the delegating person holds `run:write` at the locked instant, so the
 * agent may revise its run's state (MP-6-2). The mint holds `run` to `write`;
 * a person without it mints the task delegation it always was.
 */
async function delegatedCollections(
  tx: TenantQuery,
  request: AgentMint,
  lockedAt: string,
): Promise<readonly string[]> {
  const runWrite = await checkAuthorityAt(
    tx,
    [{ kind: 'person', id: request.authorisedByPersonId }],
    { collection: 'run', action: 'write', scope: { kind: 'business', id: null } },
    lockedAt,
  );
  return runWrite.ok ? [request.collection, 'run'] : [request.collection];
}
