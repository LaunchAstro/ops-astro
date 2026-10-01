// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 and the agent credentials an ended person issued (API-2). Ending a
// person's access revokes every live credential they issued in that business,
// in the same act, and deactivates each one's agent actor, so nothing they
// issued stays usable for its 90 days. Another person's credential in the same
// business, and the same provider user's credential in another business, are
// left as they were. Every name below is made up.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bearer, call, personPath, serverUrl, type Answer } from '../acceptance/world.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  apiWith,
  end,
  harness,
  nowSeconds,
  outcome,
  scripted,
  signedIn,
  teammate,
  useEndAccessWorld,
} from './c58-end-access-world.ts';

useEndAccessWorld();

const DAY_MS = 24 * 60 * 60 * 1000;

const issue = async (
  api: ReturnType<typeof apiWith>,
  token: string,
  key = 'alpha',
): Promise<string> => {
  const answer: Answer = await call(
    api,
    personPath(key, '/credential/issue'),
    {
      operationId: randomUUID(),
      scope: [{ collection: 'task', action: 'read' }],
      expiresAt: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      purpose: 'the command line on a laptop',
    },
    bearer(token),
  );
  expect(outcome(answer), 'the issue').toEqual({ status: 200, code: 'ok' });
  return String((answer.body['detail'] as Record<string, unknown>)['credentialId']);
};

/** Each credential's revoker (null while live) and whether its agent actor is active. */
const credentialsOf = async (
  businessId: string,
  ids: readonly string[],
): Promise<readonly { readonly revokedBy: string | null; readonly agentActive: boolean }[]> =>
  await harness.world.db.app.withBusiness(
    businessId,
    async (tx) =>
      await tx.query<{ readonly revokedBy: string | null; readonly agentActive: boolean }>(
        `select c.revoked_by_actor_id::text as "revokedBy", a.active as "agentActive"
           from unnest($1::uuid[]) with ordinality as named(id, n)
           join public.agent_credentials c on c.id = named.id
           join public.actors a on a.business_id = c.business_id and a.id = c.agent_actor_id
          order by named.n`,
        [ids],
      ),
  );

const keyed = async (businessId: string, member: Member): Promise<void> => {
  await harness.world.db.app.withBusiness(businessId, async (tx) => {
    await grantTo(tx, member, 'read', WHOLE_BUSINESS);
    await grantTo(tx, member, 'write', WHOLE_BUSINESS, false, 'credential');
  });
};

describe.skipIf(serverUrl === undefined)('C58 ending access and agent credentials', () => {
  it('access.end revokes every live credential the person issued', async () => {
    const api = apiWith(scripted().provider);
    const { world } = harness;
    const { person, token } = await teammate('ivo');
    await keyed(world.alpha, person);
    // The same provider user, live in bravo too and holding the key there.
    const inBravo = await world.db.app.withBusiness(world.bravo, async (tx) => {
      const personId = await insertPerson(tx, 'ivo-in-bravo');
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      await insertMapping(tx, await insertLogin(tx, person.presented.subject), personId, actorId);
      return { personId, actorId, presented: person.presented } satisfies Member;
    });
    await keyed(world.bravo, inBravo);
    const bravoToken = await signedIn(person.presented.subject, nowSeconds() - 60);

    const own = [await issue(api, token), await issue(api, token)];
    const adaOwn = await issue(api, world.ada.token);
    const bravoOwn = await issue(api, bravoToken, 'bravo');

    const ended = await end(api, person.personId);
    expect(outcome(ended)).toEqual({ status: 200, code: 'ok' });

    // Revoked by the manager who ended the access, each agent actor with it.
    const revoked = { revokedBy: world.ada.actorId, agentActive: false };
    expect(await credentialsOf(world.alpha, own)).toEqual([revoked, revoked]);
    // Another person's in the same business, and the same user's in bravo, untouched.
    const live = { revokedBy: null, agentActive: true };
    expect(await credentialsOf(world.alpha, [adaOwn])).toEqual([live]);
    expect(await credentialsOf(world.bravo, [bravoOwn])).toEqual([live]);
    expect((ended.body['detail'] as Record<string, unknown>)['credentialsRevoked']).toBe(2);
  });
});
