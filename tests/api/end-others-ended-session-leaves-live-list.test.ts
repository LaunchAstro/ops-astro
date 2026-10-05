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
  listOf,
  now,
  served,
  sessions,
  tokenFor,
  useSessionsWorld,
  world,
} from './c58-sessions-world.ts';

useSessionsWorld();

it("subject-wide end-others removes revoked sessions from another business's live session list", async () => {
  const subject = world.mia.subject;
  await world.db.app.withBusiness(world.bravo, async (tx) => {
    const personId = await insertPerson(tx, 'Sol live session list person in bravo');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    await grantTo(tx, { personId, actorId, presented: { provider: 'supabase', subject } }, 'read');
  });
  const keptId = randomUUID();
  const otherId = randomUUID();
  const kept = await tokenFor(subject, keptId, undefined, now() + 600, now() - 60);
  const other = await tokenFor(subject, otherId, undefined, now() + 600, now() - 60);
  expect(await served(kept, 'alpha')).toEqual(OK);
  expect(await served(kept, 'bravo')).toEqual(OK);
  expect(await served(other, 'bravo')).toEqual(OK);
  expect((await listOf(kept, 'bravo')).map((row) => row.sessionId)).toContain(otherId);
  const ended = await sessions('end-others', kept, {}, 'alpha');
  expect(ended.status).toBe(200);
  expect(ended.body['signedOutAtProvider']).toBe(true);
  expect(await served(kept, 'bravo')).toEqual(OK);
  expect(await served(other, 'bravo')).toEqual(EXPIRED);
  const live = (await listOf(kept, 'bravo')).map((row) => row.sessionId);
  expect(live).toContain(keptId);
  expect(live, 'Bravo must not offer the ended session as live').not.toContain(otherId);
});
