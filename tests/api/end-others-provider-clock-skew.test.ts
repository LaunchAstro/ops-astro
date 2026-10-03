// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { grantTo } from '../commands/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  EXPIRED,
  OK,
  now,
  served,
  sessions,
  tokenFor,
  useSessionsWorld,
  world,
} from './c58-sessions-world.ts';

useSessionsWorld();

it('end others revokes a session seen only by another business despite permitted provider clock skew', async () => {
  const subject = world.mia.subject;
  await world.db.app.withBusiness(world.bravo, async (tx) => {
    const person = await insertPerson(tx, 'Sol session proof in bravo');
    const actor = await insertActor(tx, person);
    await insertMembership(tx, person);
    await insertMapping(tx, await insertLogin(tx, subject), person, actor);
    await grantTo(
      tx,
      {
        personId: person,
        actorId: actor,
        presented: { provider: 'supabase', subject },
      },
      'read',
    );
  });
  const kept = await tokenFor(subject, randomUUID(), undefined, now() + 600, now() - 60);
  const other = await tokenFor(subject, randomUUID(), undefined, now() + 600, now() + 30);
  expect(await served(kept)).toEqual(OK);
  expect(await served(other, 'bravo')).toEqual(OK);
  const ended = await sessions('end-others', kept);
  expect(ended.status).toBe(200);
  expect(ended.body['signedOutAtProvider']).toBe(true);
  expect(await served(kept)).toEqual(OK);
  expect(await served(other, 'bravo')).toEqual(EXPIRED);
});
