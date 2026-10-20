// SPDX-License-Identifier: AGPL-3.0-only
//
// A `review:write` delegation minted for one task, on C35's world (#2103): the runtime's own
// mint, so the credential the agent presents is one the agent entry resolves. An agent holds
// one live delegation per purpose, so each mint names a purpose of its own.

import { randomUUID } from 'node:crypto';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import type { Member } from '../commands/fixture.ts';
import type { C35World } from './c35-world.ts';

export interface ReviewDelegation {
  readonly id: string;
  readonly credential: string;
}

/** `review:write` on `taskId` alone, for `member`, live for an hour. */
export async function delegateReview(
  w: C35World,
  member: Member,
  taskId: string,
): Promise<ReviewDelegation> {
  return await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: member.personId,
      mintedByActorId: member.actorId,
      purpose: `review_${randomUUID().replaceAll('-', '')}`,
      collections: ['review'],
      actions: ['write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`delegateReview: mint refused ${minted.refusal.code}`);
    return { id: minted.value.delegation.id, credential: minted.value.credential };
  });
}
