// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 refresh revoked, the API's half: a signed-out token is refused from the
// next call, not at its expiry. The browser signs out at `/api/session/end`
// (S0-6c), a person at `/account/sessions/sign-out`; either ends the
// provider's session for this API in every business the login reaches, then
// asks the provider to end it too. Only the session the tab names ends, and a
// cookie whose token does not verify ends nothing.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cookieNameFor, sessionIdOf } from '../../apps/api/auth/session.ts';
import { CSRF_HEADER, SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { ACCEPTANCE_ISSUER, call, personPath, serverUrl } from '../acceptance/world.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { signForged } from '../support/sign-in.ts';
import {
  api,
  answerWith,
  EXPIRED,
  GOOD,
  HOSTILE,
  listOf,
  now,
  OK,
  seen,
  served,
  sessions,
  tokenFor,
  useSessionsWorld,
  world,
} from './c58-sessions-world.ts';

useSessionsWorld();

const SAME_ORIGIN = { [CSRF_HEADER]: '1', 'sec-fetch-site': 'same-origin' };

/** The browser's request for one sign-in: its cookie, named by its tab. */
const asTab = (token: string): Record<string, string> => ({
  cookie: `${cookieNameFor(sessionIdOf(token))}=${token}`,
  [SESSION_HEADER]: sessionIdOf(token),
  ...SAME_ORIGIN,
});

/** The browser's sign-out: batch 1's route, naming the tab's own sign-in. */
const endInBrowser = async (token: string) => await call(api, '/api/session/end', {}, asTab(token));

/** A read on the browser's cookie, as the page makes it. */
const servedAsTab = async (token: string, key = 'alpha') => {
  const answer = await call(api, personPath(key, '/session/capabilities'), {}, asTab(token));
  return { status: answer.status, code: answer.code };
};

/** Mia's login made a member of bravo too: one subject, two businesses. */
async function inBravoToo(subject: string): Promise<void> {
  await world.db.app.withBusiness(world.bravo, async (tx) => {
    const personId = await insertPerson(tx, 'mia-in-bravo');
    const actorId = await insertActor(tx, personId);
    await insertMembership(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
  });
}

async function browserSignOut(): Promise<void> {
  const session = randomUUID();
  const token = await tokenFor(world.mia.subject, session);
  expect(await servedAsTab(token)).toEqual(OK);

  const ended = await endInBrowser(token);
  expect(ended.status).toBe(200);
  expect(ended.body).toEqual({ ok: true });

  expect(await servedAsTab(token)).toEqual(EXPIRED);
  expect(await served(token)).toEqual(EXPIRED);
  // A refresh keeps the provider's session: a new token for it is refused too.
  expect(await served(await tokenFor(world.mia.subject, session))).toEqual(EXPIRED);
  // The provider was asked to end that session, with that session's own token.
  expect(seen).toEqual([{ route: 'POST /logout?scope=local', authorization: `Bearer ${token}` }]);
}

async function everyBusiness(): Promise<void> {
  await inBravoToo(world.mia.subject);
  const [browser, account] = [randomUUID(), randomUUID()];
  const browserToken = await tokenFor(world.mia.subject, browser);
  const accountToken = await tokenFor(world.mia.subject, account);
  // Bravo resolves her and grants her nothing: past the door, refused for scope.
  const resolved = { alpha: OK, bravo: { status: 403, code: 'SCOPE_NOT_GRANTED' } };
  for (const token of [browserToken, accountToken]) {
    for (const key of ['alpha', 'bravo'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await served(token, key)).toEqual(resolved[key]);
    }
  }

  expect((await endInBrowser(browserToken)).status).toBe(200);
  // Signed out in alpha on the account route; bravo never saw that sign-out.
  expect((await sessions('sign-out', accountToken)).status).toBe(200);

  for (const token of [browserToken, accountToken]) {
    for (const key of ['alpha', 'bravo']) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await served(token, key)).toEqual(EXPIRED);
    }
  }
  // Nor does bravo's list offer either as live.
  const still = await tokenFor(world.mia.subject, randomUUID());
  const listed = (await listOf(still, 'bravo')).map((row) => row.sessionId);
  expect(listed).not.toContain(browser);
  expect(listed).not.toContain(account);
}

async function lateSignOut(): Promise<void> {
  const [old, fresh] = [randomUUID(), randomUUID()];
  const oldToken = await tokenFor(world.mia.subject, old);
  const freshToken = await tokenFor(world.mia.subject, fresh);
  expect(await servedAsTab(freshToken)).toEqual(OK);

  expect((await endInBrowser(oldToken)).status).toBe(200);

  expect(await served(oldToken)).toEqual(EXPIRED);
  expect(await servedAsTab(freshToken)).toEqual(OK);
  expect(await served(freshToken)).toEqual(OK);
}

async function checksFirst(): Promise<void> {
  const session = randomUUID();
  const genuine = await tokenFor(world.mia.subject, session);
  const forged = await signForged({
    sub: world.mia.subject,
    aud: 'authenticated',
    iss: ACCEPTANCE_ISSUER,
    exp: now() + 600,
    session_id: session,
  });
  const lapsed = await tokenFor(world.mia.subject, session, undefined, now() - 5);

  for (const token of [forged, lapsed]) {
    // oxlint-disable-next-line no-await-in-loop
    const answer = await endInBrowser(token);
    // The cookie is still cleared; nothing else happens.
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true });
  }
  expect(seen).toEqual([]);
  expect(await served(genuine)).toEqual(OK);
}

async function hostileProvider(): Promise<void> {
  for (const [name, reply] of Object.entries(HOSTILE)) {
    answerWith({ ...GOOD, 'POST /logout?scope=local': reply });
    // oxlint-disable-next-line no-await-in-loop
    const token = await tokenFor(world.mia.subject, randomUUID());
    // oxlint-disable-next-line no-await-in-loop
    const answer = await endInBrowser(token);
    expect(answer.status, name).toBe(200);
    expect(answer.text, name).not.toContain('CANARY');
    // oxlint-disable-next-line no-await-in-loop
    const next = await served(token);
    expect(next, name).toEqual(EXPIRED);
  }
}

describe.skipIf(serverUrl === undefined)(
  'C58 refresh revoked: signing out ends the token at once',
  () => {
    it(
      'C58 sign-out revoked: a token signed out in the browser is refused on its next call, as its cookie and as a bearer',
      browserSignOut,
    );
    it(
      'C58 sign-out revoked in every business: either sign-out ends the session wherever the login reaches',
      everyBusiness,
    );
    it(
      'C58 late sign-out: an old tab signing out ends its own session and never a newer one',
      lateSignOut,
    );
    it(
      'C58 sign-out checks first: a cookie that does not verify, or has expired, ends nothing',
      checksFirst,
    );
    it(
      'C58 sign-out revoked whatever the provider answers: a hostile answer never undoes the local ending',
      hostileProvider,
      30_000,
    );
  },
);
