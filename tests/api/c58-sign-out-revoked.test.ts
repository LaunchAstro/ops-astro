// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 refresh revoked, the API's half: a signed-out token is refused from the
// next call, not at its expiry. The web client signs out on the person prefix
// (`/account/sessions/sign-out`, the only path its cookie is sent to), then
// clears the cookie at `/api/session/end` (S0-6c). That ends the provider's
// session for this API in every business the login reaches, then asks the
// provider to end it too. Only the session the tab names ends, and a cookie
// whose token does not verify ends nothing. The browser here keeps cookies to
// their Path, as a real one does (the interim review's cookie-path proof).

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cookieNameFor, SESSION_COOKIE_OPTIONS, sessionIdOf } from '../../apps/api/auth/session.ts';
import { signOut } from '../../apps/web/src/session/sign-in.ts';
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

/** RFC 6265 5.1.4: a browser sends a cookie only to a path its Path matches. */
const pathMatches = (path: string, cookiePath: string): boolean =>
  path === cookiePath ||
  (path.startsWith(cookiePath) && (cookiePath.endsWith('/') || path[cookiePath.length] === '/'));

/**
 * The web client's own sign-out (`signOut`), through a browser holding the
 * tab's cookie at the Path the API set it with, so `/api/session/end` gets no
 * cookie and the person-prefix route does.
 */
async function endInBrowser(token: string): Promise<void> {
  const cookie = `${cookieNameFor(sessionIdOf(token))}=${token}`;
  const browser = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set('sec-fetch-site', 'same-origin');
    const path = new URL(String(url)).pathname;
    if (pathMatches(path, SESSION_COOKIE_OPTIONS.path)) headers.set('cookie', cookie);
    return await api.fetch(new Request(String(url), { ...init, headers }));
  };
  await signOut({
    apiOrigin: 'http://api.test',
    fetch: browser as typeof fetch,
    sessionId: sessionIdOf(token),
    businessKey: 'alpha',
  });
}

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

  await endInBrowser(token);

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

  await endInBrowser(browserToken);
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

  await endInBrowser(oldToken);

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
    await endInBrowser(token);
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
    await endInBrowser(token);
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
