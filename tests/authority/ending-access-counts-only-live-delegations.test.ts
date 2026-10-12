// SPDX-License-Identifier: AGPL-3.0-only
//
// Ending a person's access revokes and counts the delegations they gave that
// are still live. One that already expired ended by its own column, so it is
// neither revoked a second way nor counted in `delegationsRevoked`.

import { describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  apiWith,
  end,
  harness,
  outcome,
  scripted,
  teammate,
  useEndAccessWorld,
} from './c58-end-access-world.ts';

useEndAccessWorld();

describe.skipIf(serverUrl === undefined)('C58 ending access counts only what it ends', () => {
  it('a delegation that already expired is neither revoked again nor counted', async () => {
    const api = apiWith(scripted().provider);
    const { person } = await teammate('ivy');
    const mint = async (purpose: string): Promise<string> => {
      const minted = await harness.world.db.app.withBusiness(
        harness.world.alpha,
        async (tx) =>
          await mintDelegation(tx, {
            agentActorId: harness.world.agent.actorId as string,
            delegatePersonId: person.personId,
            mintedByActorId: person.actorId,
            purpose,
            collections: ['task'],
            actions: ['write'],
            purposeScope: { kind: 'record', id: harness.alphaTask.id },
            expiresAt: new Date(Date.now() + 3_600_000),
          }),
      );
      if (!minted.ok) throw new Error(`the delegation was refused ${minted.refusal.code}`);
      return minted.value.delegation.id;
    };
    await mint('c58_live');
    const expired = await mint('c58_expired');
    await harness.world.db.admin.execute(
      `update public.delegations
          set granted_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        where id = $1`,
      [expired],
    );

    const ended = await end(api, person.personId);
    const [row] = await harness.world.db.admin.execute<{ revoked: boolean }>(
      `select revoked_at is not null as revoked from public.delegations where id = $1`,
      [expired],
    );
    expect({
      ...outcome(ended),
      delegationsRevoked: (ended.body['detail'] as Record<string, unknown>)['delegationsRevoked'],
      expiredRevoked: row?.revoked,
    }).toEqual({ status: 200, code: 'ok', delegationsRevoked: 1, expiredRevoked: false });
  });
});
