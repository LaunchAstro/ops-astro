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
// ending (0063): a session of that login, not the kept one, whose first
// sign-in is at or before the ending is refused in every business; a sign-in
// after it is served. A factor change in alpha ends bravo's sessions the
// same way, and the session kept by either act is still served in bravo.

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
import { ACCEPTANCE_ISSUER, bearer, call, personPath } from '../acceptance/world.ts';
import {
  api,
  clientA,
  clientB,
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

/** Bravo resolves the login and grants it nothing: past the door, refused for scope. */
const IN_BRAVO = { status: 403, code: 'SCOPE_NOT_GRANTED' };

async function inBravoToo(subject: string, name = 'mia-in-bravo'): Promise<void> {
  await world.db.app.withBusiness(world.bravo, async (tx) => {
    const personId = await insertPerson(tx, name);
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
  });
}

/** A factor change from one session, in alpha, of a login bravo also admits. */
async function factorChangeEverywhere(): Promise<void> {
  const subject = clientA.presented.subject;
  await inBravoToo(subject, 'client-a-in-bravo');
  const [here, elsewhere] = [randomUUID(), randomUUID()];
  // Both signed in a minute before the change: only the kept one may outlive it.
  const before = now() - 60;
  const hereToken = await tokenFor(subject, here, undefined, undefined, before);
  const elsewhereToken = await tokenFor(subject, elsewhere, undefined, undefined, before);
  expect(await served(elsewhereToken, 'bravo')).toEqual(IN_BRAVO);

  // In alpha, from `here`: enrol a second factor and give its first code.
  const enrolled = await call(
    api,
    personPath('alpha', '/account/factor/enrol'),
    {},
    bearer(hereToken),
  );
  expect(enrolled.status).toBe(200);
  const verified = await call(
    api,
    personPath('alpha', '/account/factor/verify'),
    { code: '123456' },
    bearer(hereToken),
  );
  expect(verified.status).toBe(200);

  // The session that only ever called bravo is over, in bravo and in alpha.
  expect(await served(elsewhereToken, 'bravo')).toEqual(EXPIRED);
  expect(await served(elsewhereToken, 'alpha')).toEqual(EXPIRED);
  // The session that made the change, refreshed at the assurance its code raised.
  const kept = await tokenFor(subject, here, { aal: 'aal2', totp: now() }, undefined, before);
  expect(await served(kept, 'alpha')).toEqual(OK);
  expect(await served(kept, 'bravo')).toEqual(IN_BRAVO);
}

/** End-others from one session, in alpha, of a login bravo also admits. */
async function keptInBravo(): Promise<void> {
  const subject = clientB.presented.subject;
  await inBravoToo(subject, 'client-b-in-bravo');
  const [kept, other] = [randomUUID(), randomUUID()];
  const before = now() - 60;
  const keptToken = await tokenFor(subject, kept, undefined, undefined, before);
  const otherToken = await tokenFor(subject, other, undefined, undefined, before);
  expect(await served(keptToken, 'bravo')).toEqual(IN_BRAVO);
  expect(await served(otherToken, 'bravo')).toEqual(IN_BRAVO);

  expect((await sessions('end-others', keptToken)).status).toBe(200);

  expect(await served(otherToken, 'bravo')).toEqual(EXPIRED);
  // The kept session, and a refresh of it, still pass bravo's door.
  expect(await served(keptToken, 'bravo')).toEqual(IN_BRAVO);
  expect(
    await served(await tokenFor(subject, kept, undefined, undefined, before), 'bravo'),
  ).toEqual(IN_BRAVO);
  expect(await served(keptToken, 'alpha')).toEqual(OK);
}

describe.skipIf(serverUrl === undefined)('C58 end other sessions in every business', () => {
  it('C58 end other sessions: end-others in alpha refuses a session of the same login that has only called bravo', async () => {
    await inBravoToo(world.mia.subject);
    const [phone, laptop] = [randomUUID(), randomUUID()];
    // Both signed in a minute before the ending below.
    const before = now() - 60;
    const phoneToken = await tokenFor(world.mia.subject, phone, undefined, undefined, before);
    const laptopToken = await tokenFor(world.mia.subject, laptop, undefined, undefined, before);
    expect(await served(phoneToken, 'alpha')).toEqual(OK);
    // The laptop is past the door in bravo (403 for scope, not for sign-in).
    const inBravo = await served(laptopToken, 'bravo');
    expect(inBravo.status).toBe(403);

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
describe.skipIf(serverUrl === undefined)('C58 end other sessions in every business', () => {
  it(
    'C58 end other sessions: a factor change in alpha ends the login’s sessions in bravo too and keeps the one that made it',
    factorChangeEverywhere,
  );
  it(
    'C58 end other sessions: after end-others in alpha the kept session is still served in bravo',
    keptInBravo,
  );
});
