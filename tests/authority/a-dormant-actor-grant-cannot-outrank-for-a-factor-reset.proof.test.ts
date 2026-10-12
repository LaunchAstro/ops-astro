// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { checkAuthority, issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { serverUrl } from '../acceptance/world.ts';
import { grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { insertActor } from '../identity/fixture.ts';
import { apiWith, harness, outcome, useEndAccessWorld } from './c58-end-access-world.ts';
import { factorFake, memberWithFactor, reset, resetState } from './c59-factor-reset-world.ts';

useEndAccessWorld();

describe.skipIf(serverUrl === undefined)('inactive actor factor reset rank', () => {
  it('a dormant actor grant cannot authorise resetting a higher-ranked person factor', async () => {
    const keeper = await memberWithFactor('keeper');
    const higher = await memberWithFactor('higher');
    await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
      await grantTo(tx, keeper.person, 'manage', WHOLE_BUSINESS, false, 'settings');
      await grantTo(tx, higher.person, 'manage', WHOLE_BUSINESS, false, 'settings');
      await grantTo(tx, higher.person, 'decide', WHOLE_BUSINESS);
      const inactiveActor = await insertActor(tx, keeper.person.personId, false);
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'actor', id: inactiveActor },
        collection: 'task',
        action: 'decide',
        scope: WHOLE_BUSINESS,
        parentGrantId: null,
        grantedByActorId: String(harness.world.ada.actorId),
      });
      expect(issued.ok).toBe(true);
      const authority = await checkAuthority(
        tx,
        [
          { kind: 'person', id: keeper.person.personId },
          { kind: 'actor', id: keeper.person.actorId },
        ],
        { collection: 'task', action: 'decide', scope: WHOLE_BUSINESS },
      );
      expect(authority.ok).toBe(false);
    });

    const before = await resetState(higher.person);
    const { calls, provider } = factorFake();
    const answer = await reset(apiWith(provider), higher.person.personId, keeper.token);
    expect.soft(outcome(answer)).toStrictEqual({ status: 409, code: 'FACTOR_RESET_REFUSED' });
    expect.soft(await resetState(higher.person)).toStrictEqual(before);
    expect.soft(calls).toStrictEqual([]);
  });
});
