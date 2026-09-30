// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 end other sessions in every business (ORCH47 on the interim review's
// finding 2; its proof applied, titles made behaviours). "End my other sessions"
// in alpha ends only the session ids alpha's own `authentication_attempts`
// saw for the person (sessions.ts endOtherSeenSessions). A session of the same
// login that has only ever called bravo is never named, so after end-others
// (and so after a factor change, which uses the same helper) it is still
// served in bravo: until its token expires, or for the whole 12 hours when the
// provider's `scope=others` sign-out did not land. Fixed by a subject-wide
// ending (0069): a session of that login, not the kept one, whose first
// sign-in is at or before the ending is refused in every business; a sign-in
// after it is served.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { signBearer } from '../support/sign-in.ts';
import { ACCEPTANCE_ISSUER } from '../acceptance/world.ts';
import {
  EXPIRED,
  now,
  OK,
  served,
  sessions,
  tokenFor,
  useSessionsWorld,
  world,
} from './c58-sessions-world.ts';

useSessionsWorld();

async function inBravoToo(subject: string): Promise<void> {
  await world.db.app.withBusiness(world.bravo, async (tx) => {
    const personId = await insertPerson(tx, 'mia-in-bravo');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
  });
}

describe.skipIf(serverUrl === undefined)('C58 end other sessions in every business', () => {
  it('C58 end other sessions: end-others in alpha refuses a session of the same login that has only called bravo', async () => {
    await inBravoToo(world.mia.subject);
    const [phone, laptop] = [randomUUID(), randomUUID()];
    const phoneToken = await tokenFor(world.mia.subject, phone);
    const laptopToken = await tokenFor(world.mia.subject, laptop);
    expect(await served(phoneToken, 'alpha')).toEqual(OK);
    // The laptop is past the door in bravo (403 for scope, not for sign-in).
    const before = await served(laptopToken, 'bravo');
    expect(before.status).toBe(403);

    // On the phone, in alpha: end every other session.
    const ended = await sessions('end-others', phoneToken);
    expect(ended.status).toBe(200);

    expect(await served(phoneToken, 'alpha')).toEqual(OK);
    // The laptop is one of her other sessions; it must be over everywhere.
    expect(await served(laptopToken, 'bravo')).toEqual(EXPIRED);
  });

  it('C58 end other sessions: a sign-in after the ending is served in every business', async () => {
    const [kept, other] = [randomUUID(), randomUUID()];
    const keptToken = await tokenFor(world.mia.subject, kept);
    expect(await served(await tokenFor(world.mia.subject, other), 'alpha')).toEqual(OK);
    expect((await sessions('end-others', keptToken)).status).toBe(200);
    // Two seconds on, a fresh sign-in: its first-factor time is after the ending.
    const fresh = await signBearer({
      sub: world.mia.subject,
      aud: 'authenticated',
      iss: ACCEPTANCE_ISSUER,
      exp: now() + 600,
      aal: 'aal1',
      session_id: randomUUID(),
      amr: [{ method: 'password', timestamp: now() + 2 }],
    });
    expect(await served(fresh, 'alpha')).toEqual(OK);
    expect((await served(fresh, 'bravo')).status).toBe(403);
    expect(await served(keptToken, 'alpha')).toEqual(OK);
  });
});
