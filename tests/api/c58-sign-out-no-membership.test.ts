// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 sign-out without membership (the Opus-after review's proof on abe5f48,
// applied; titles made behaviours): the web sign-out ends its session only
// through the tab's business. When that business no longer admits the person
// (their access there has just ended, as C58's owner check does, while their
// login is still live in bravo), the account route refuses, nothing is ended
// here or at the provider, and `/api/session/end` still clears the cookie: the
// tab says signed out while the sign-in still serves bravo.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cookieNameFor, SESSION_COOKIE_OPTIONS, sessionIdOf } from '../../apps/api/auth/session.ts';
import { signOut } from '../../apps/web/src/session/sign-in.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  api,
  EXPIRED,
  seen,
  served,
  tokenFor,
  useSessionsWorld,
  world,
} from './c58-sessions-world.ts';

useSessionsWorld();

const pathMatches = (path: string, cookiePath: string): boolean =>
  path === cookiePath ||
  (path.startsWith(cookiePath) && (cookiePath.endsWith('/') || path[cookiePath.length] === '/'));

/** The web client's own sign-out, through a browser that keeps the cookie to its Path. */
async function endInBrowser(token: string, businessKey: string): Promise<void> {
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
    businessKey,
  });
}

describe.skipIf(serverUrl === undefined)('C58 sign-out without membership', () => {
  it('C58 sign-out revoked: signing out of a tab whose business no longer admits the person still ends the sign-in everywhere', async () => {
    const subject = world.mia.subject;
    // Mia is live in bravo too.
    await world.db.app.withBusiness(world.bravo, async (tx) => {
      const personId = await insertPerson(tx, 'mia-in-bravo');
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    });
    const token = await tokenFor(subject, randomUUID());
    expect((await served(token, 'bravo')).status).not.toBe(401);

    // Alpha ends her access: what `access.end` writes locally (endStanding).
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await tx.query(
        `update public.memberships set active = false, ended_at = now()
          where business_id = $1 and person_id = $2::uuid and active`,
        [world.alpha, world.mia.personId],
      );
      await tx.query(
        `update public.actors set active = false, deactivated_at = now()
          where business_id = $1 and person_id = $2::uuid and kind = 'person' and active`,
        [world.alpha, world.mia.personId],
      );
    });

    // Her alpha tab signs out, as the top bar's button does.
    await endInBrowser(token, 'alpha');

    // The tab is signed out, so the sign-in must be over: here and at the provider.
    expect(await served(token, 'bravo')).toEqual(EXPIRED);
    expect(seen.map((each) => each.route)).toEqual(['POST /logout?scope=local']);
  });
});
